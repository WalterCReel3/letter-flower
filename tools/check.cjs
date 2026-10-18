#!/usr/bin/env node
'use strict';
/*
 * Flower Letters headless checker.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=./.pw-browsers node tools/check.cjs [--shots DIR] [files...]
 *
 * Default files: every variants/*.html except index.html. Screenshots go to
 * shots/<name>-<w>x<h>.png (override with --shots DIR).
 *
 * For each file and each viewport (412x760 primary = Pixel 8/7a visible area,
 * 412x915 full, 360x640 small floor), in a fresh mobile context
 * (isMobile, hasTouch, DPR 2.625) with all http(s) requests aborted (offline;
 * Google Fonts must fall back), it checks:
 *
 *   errors  no pageerror and no console.error (console errors that are only
 *           "Failed to load resource" for a request this script aborted are
 *           ignored, nothing else is).
 *   fit     no page overflow: scrollingElement.scrollHeight <= innerHeight+1
 *           and scrollWidth <= innerWidth+1; window.scrollY/scrollX stay 0;
 *           every visible button lies inside the viewport and is the element
 *           hit at its own centre (not covered/clipped). Checked at load and
 *           again with a 12-letter word typed.
 *           "Visible" excludes buttons that are display:none, visibility:hidden,
 *           opacity 0, zero-size, or inside [hidden], [inert], [aria-hidden=true]
 *           or a closed <dialog>. A closed off-canvas menu must use one of those
 *           (it should anyway, so its buttons are not focusable/tappable);
 *           otherwise its buttons are reported as outside the viewport.
 *           Buttons inside an internally scrolling container (overflow auto /
 *           scroll) only need the container's visible box to be on-screen.
 *   tap     page.touchscreen.tap on the centre letter and two petal letters
 *           -> word length +3 exactly; tap Back (#del) -> -1. If the page has no
 *           #del (variant D), Backspace key is used instead and noted. Then
 *           taps up to 12 letters -> exactly 12, one more tap -> still 12.
 *   press   long-press a petal letter via CDP Input.dispatchTouchEvent
 *           (touchStart, 800 ms, touchEnd): adds at most one letter,
 *           window.getSelection().toString() is empty, the page did not scroll,
 *           and any contextmenu event that fired was preventDefault()ed; a
 *           synthetic contextmenu on the letter must also be cancelled.
 *   shot    screenshot after the 12-letter fit check.
 *
 * Word length is read from window.Game.state() (first string/array field of:
 * typed, word, current, input, letters, guess) if present, else from the
 * letters in #word's textContent. The source used is printed per row.
 *
 * Exit: 0 all PASS, 1 any FAIL, 2 setup problem (no files, no browser).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VIEWPORTS = [
  { w: 412, h: 760, tag: 'primary' },
  { w: 412, h: 915, tag: 'full' },
  { w: 360, h: 640, tag: 'small' },
];
const TAP_GAP_MS = 120; // a quick child's tap rhythm
const SETTLE_MS = 150;

function parseArgs(argv) {
  let shots = path.join(ROOT, 'shots');
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--shots') shots = path.resolve(argv[++i]);
    else files.push(path.resolve(argv[i]));
  }
  if (!files.length) {
    const dir = path.join(ROOT, 'variants');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).sort()) {
        if (f.endsWith('.html') && f !== 'index.html') files.push(path.join(dir, f));
      }
    }
  }
  return { shots, files };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- in-page helpers (serialised into the page) ----

function pageReadTyped() {
  try {
    if (window.Game && typeof window.Game.state === 'function') {
      const s = window.Game.state();
      if (s && typeof s === 'object') {
        for (const k of ['typed', 'word', 'current', 'input', 'letters', 'guess']) {
          if (typeof s[k] === 'string') return { src: 'Game.state().' + k, len: s[k].length, v: s[k] };
          if (Array.isArray(s[k])) return { src: 'Game.state().' + k, len: s[k].length, v: s[k].join('') };
        }
      }
    }
  } catch (e) { /* fall through */ }
  const w = document.getElementById('word');
  if (w) {
    const v = (w.textContent || '').replace(/[^a-z]/gi, '');
    return { src: '#word', len: v.length, v };
  }
  return null;
}

function pageFit() {
  const out = [];
  const se = document.scrollingElement || document.documentElement;
  const W = window.innerWidth, H = window.innerHeight;
  if (se.scrollHeight > H + 1) out.push(`page scrollHeight ${se.scrollHeight} > innerHeight ${H}`);
  if (se.scrollWidth > W + 1) out.push(`page scrollWidth ${se.scrollWidth} > innerWidth ${W}`);
  if (window.scrollY !== 0 || window.scrollX !== 0) out.push(`page is scrolled (${window.scrollX},${window.scrollY})`);

  const desc = el => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/).join('.');
    const t = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 20);
    return t ? `${s} "${t}"` : s;
  };
  const hiddenByAncestor = el => {
    for (let a = el; a; a = a.parentElement) {
      if (a.hidden || a.hasAttribute('inert') || a.getAttribute('aria-hidden') === 'true') return true;
      if (a.tagName === 'DIALOG' && !a.open) return true;
    }
    return false;
  };
  const scrollBox = el => {
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (/(auto|scroll)/.test(cs.overflowX + ' ' + cs.overflowY)) return a;
    }
    return null;
  };
  const inView = r => r.left >= -1 && r.top >= -1 && r.right <= W + 1 && r.bottom <= H + 1;

  for (const b of document.querySelectorAll('button, [role="button"], a[href]')) {
    if (hiddenByAncestor(b)) continue;
    const vis = typeof b.checkVisibility === 'function'
      ? b.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      : getComputedStyle(b).visibility !== 'hidden';
    if (!vis) continue;
    const r = b.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const box = scrollBox(b);
    if (box) {
      const br = box.getBoundingClientRect();
      if (!inView(br)) out.push(`scroll container of ${desc(b)} outside viewport (${Math.round(br.top)}..${Math.round(br.bottom)})`);
      continue; // position inside its own scroller is the scroller's business
    }
    if (!inView(r)) {
      out.push(`${desc(b)} outside viewport (x ${Math.round(r.left)}..${Math.round(r.right)}, y ${Math.round(r.top)}..${Math.round(r.bottom)})`);
      continue;
    }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || !(hit === b || b.contains(hit))) out.push(`${desc(b)} covered at its centre by ${hit ? desc(hit) : 'nothing'}`);
  }
  return out;
}

function pageLetters() {
  const box = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, ch: (el.textContent || '').trim() }; };
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  let center = document.querySelector('#flower button.m, #flower [data-center]');
  let petals = [...document.querySelectorAll('#flower button.o')].filter(vis);
  if (!center || !petals.length) {
    const all = [...document.querySelectorAll('#flower button, button[aria-label^="letter "]')].filter(vis);
    if (!center) center = all[0] || null;
    if (!petals.length) petals = all.filter(b => b !== center);
  }
  const del = document.getElementById('del');
  return {
    center: center ? box(center) : null,
    petals: petals.map(box),
    back: del && vis(del) ? box(del) : null,
  };
}

// ---- runner ----

async function checkOne(browser, file, vp, shotsDir) {
  const res = { file: path.basename(file), vp: `${vp.w}x${vp.h}`, errors: [], fit: [], tap: [], press: [], notes: [] };
  const context = await browser.newContext({
    viewport: { width: vp.w, height: vp.h },
    screen: { width: vp.w, height: vp.h },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2.625,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  });
  const blocked = new Set();
  await context.route(/^https?:\/\//, route => { blocked.add(route.request().url()); return route.abort(); });
  const page = await context.newPage();
  page.on('pageerror', e => res.errors.push('pageerror: ' + (e && e.message || e)));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const loc = m.location() || {};
    if (/Failed to load resource/i.test(m.text()) && (blocked.has(loc.url) || /^https?:/.test(loc.url || ''))) return;
    res.errors.push('console.error: ' + m.text());
  });
  page.on('dialog', d => d.dismiss().catch(() => {}));

  try {
    await page.goto('file://' + file, { waitUntil: 'load' });
    await page.evaluate(() => {
      window.__cm = [];
      window.addEventListener('contextmenu', e => window.__cm.push(e.defaultPrevented), false);
    });
    await sleep(400);

    // fit at load
    for (const f of await page.evaluate(pageFit)) res.fit.push('[load] ' + f);

    const read = async () => page.evaluate(pageReadTyped);
    const L = await page.evaluate(pageLetters);
    let r0 = await read();
    if (!r0) { res.tap.push('cannot read typed word (no Game.state() typed field and no #word)'); }
    else res.notes.push('word via ' + r0.src);
    if (!L.center) res.tap.push('no centre letter button found');
    if (L.petals.length < 2) res.tap.push(`only ${L.petals.length} petal letter buttons found`);

    if (r0 && L.center && L.petals.length >= 2) {
      const tap = async p => { await page.touchscreen.tap(p.x, p.y); await sleep(TAP_GAP_MS); };
      const start = r0.len;
      await tap(L.center); await tap(L.petals[0]); await tap(L.petals[1]);
      await sleep(SETTLE_MS);
      let r = await read();
      if (r.len - start !== 3) res.tap.push(`3 letter taps changed word length by ${r.len - start} ("${r0.v}" -> "${r.v}")`);
      const before = r.len;
      if (L.back) await tap(L.back);
      else { await page.keyboard.press('Backspace'); res.notes.push('no #del: Back tested with Backspace key'); }
      await sleep(SETTLE_MS);
      r = await read();
      if (r.len - before !== -1) res.tap.push(`Back changed word length by ${r.len - before} ("${r.v}")`);

      // long-press
      const cdp = await context.newCDPSession(page);
      const p = L.petals[Math.min(2, L.petals.length - 1)];
      const pre = r.len;
      await page.evaluate(() => { window.__cm = []; try { getSelection().removeAllRanges(); } catch (e) {} });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
      await sleep(800);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(SETTLE_MS + 100);
      r = await read();
      const lp = await page.evaluate(({ x, y }) => {
        const sel = (window.getSelection() || '').toString();
        const el = document.elementFromPoint(x, y);
        const btn = el && el.closest('button') || el;
        let cancelled = null;
        if (btn) cancelled = !btn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        return { sel, cmAll: window.__cm.slice(), cancelled, sx: window.scrollX, sy: window.scrollY };
      }, p);
      const added = r.len - pre;
      if (added > 1) res.press.push(`long-press added ${added} letters`);
      if (added < 0) res.press.push(`long-press removed ${-added} letters`);
      if (lp.sel) res.press.push(`text selected after long-press: "${lp.sel.slice(0, 30)}"`);
      if (lp.sx || lp.sy) res.press.push(`page scrolled to (${lp.sx},${lp.sy}) after long-press`);
      // the last entry is our own synthetic event; earlier ones came from the long-press
      const fromPress = lp.cmAll.slice(0, -1);
      if (fromPress.some(prevented => !prevented)) res.press.push('long-press fired a contextmenu that was not prevented');
      if (lp.cancelled === false) res.press.push('contextmenu on a letter is not preventDefault()ed');
      if (added === 1) res.notes.push('long-press added 1 letter');

      // fill to 12, then one over the cap
      r = await read();
      const letters = [L.center, ...L.petals];
      let i = 0, guard = 0;
      while (r.len < 12 && guard++ < 20) { await tap(letters[i++ % letters.length]); r = await read(); }
      await sleep(SETTLE_MS);
      r = await read();
      if (r.len !== 12) res.tap.push(`could not reach 12 letters by tapping (got ${r.len} after ${guard} taps)`);
      await tap(L.center);
      await sleep(SETTLE_MS);
      const r13 = await read();
      if (r13.len !== r.len) res.tap.push(`tap past 12-letter cap changed length ${r.len} -> ${r13.len}`);
      await sleep(400);
      for (const f of await page.evaluate(pageFit)) res.fit.push('[12 letters] ' + f);
    }

    fs.mkdirSync(shotsDir, { recursive: true });
    const shot = path.join(shotsDir, `${path.basename(file, '.html')}-${vp.w}x${vp.h}.png`);
    await page.screenshot({ path: shot });
    res.notes.push('shot ' + path.relative(process.cwd(), shot));
  } catch (e) {
    res.errors.push('checker exception: ' + (e && e.message || e));
  } finally {
    await context.close().catch(() => {});
  }
  return res;
}

async function main() {
  const { shots, files } = parseArgs(process.argv.slice(2));
  if (!files.length) { console.error('No files to check (variants/*.html is empty and none given).'); process.exit(2); }
  for (const f of files) if (!fs.existsSync(f)) { console.error('Missing file: ' + f); process.exit(2); }

  let chromium;
  try { ({ chromium } = require(path.join(ROOT, 'node_modules', 'playwright'))); }
  catch (e) { console.error('Playwright not installed: ' + e.message); process.exit(2); }
  let browser;
  // --disable-gpu + --disable-dev-shm-usage: without both, newPage() hangs forever
  // inside the bubblewrap sandbox these sessions run in (found by trial).
  try { browser = await chromium.launch({ args: ['--disable-gpu', '--disable-dev-shm-usage'], timeout: 30000 }); }
  catch (e) { console.error('Cannot launch Chromium (set PLAYWRIGHT_BROWSERS_PATH=./.pw-browsers?): ' + e.message); process.exit(2); }

  const rows = [];
  try {
    for (const f of files) for (const vp of VIEWPORTS) {
      // a hung page must become a FAIL, never a silent stall
      let timer;
      const timeout = new Promise(res => { timer = setTimeout(() => res({
        file: path.basename(f), vp: `${vp.w}x${vp.h}`, errors: ['checker timed out after 90 s'], fit: [], tap: [], press: [], notes: [] }), 90000); });
      rows.push(await Promise.race([checkOne(browser, f, vp, shots), timeout]));
      clearTimeout(timer);
    }
  } finally { await browser.close(); }

  const cell = a => (a.length ? 'FAIL' : 'PASS');
  const nameW = Math.max(4, ...rows.map(r => r.file.length));
  const line = (...c) => c[0].padEnd(nameW) + '  ' + c[1].padEnd(8) + '  ' + c.slice(2).map(s => s.padEnd(6)).join('  ');
  console.log(line('file', 'viewport', 'errors', 'fit', 'tap', 'press', 'RESULT'));
  console.log('-'.repeat(nameW + 52));
  let anyFail = false;
  for (const r of rows) {
    const fail = r.errors.length || r.fit.length || r.tap.length || r.press.length;
    if (fail) anyFail = true;
    console.log(line(r.file, r.vp, cell(r.errors), cell(r.fit), cell(r.tap), cell(r.press), fail ? 'FAIL' : 'PASS'));
  }
  console.log('');
  for (const r of rows) {
    const items = [
      ...r.errors.map(x => 'errors: ' + x), ...r.fit.map(x => 'fit: ' + x),
      ...r.tap.map(x => 'tap: ' + x), ...r.press.map(x => 'press: ' + x),
    ];
    console.log(`${r.file} ${r.vp}: ${items.length ? 'FAIL' : 'PASS'}  (${r.notes.join('; ')})`);
    for (const x of items) console.log('    - ' + x);
  }
  console.log('\n' + (anyFail ? 'OVERALL: FAIL' : 'OVERALL: PASS'));
  process.exit(anyFail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
