#!/usr/bin/env node
'use strict';
/*
 * Flower Letters PWA check.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=./.pw-browsers node tools/serve-check.cjs
 *
 * Serves the repo with Node's http module at http://localhost:<free port>/letter-flower/ (the same
 * sub-path as GitHub Pages, so an absolute URL in the app shows up as a 404), opens index.html in
 * Playwright Chromium as a Pixel-sized phone, and checks:
 *   manifest   parses; id/start_url/scope "./", name, display, orientation, colours; every icon loads at
 *              its declared size; one icon is maskable; Chromium reports no manifest errors.
 *   sw         ./sw.js registers, activates and controls the page after a reload; its caches are named
 *              letter-flower-*, hold the page, manifest, icons and fonts, and nothing under variants/.
 *   fonts      Andika 400/700 and Baloo 2 600/800 are loaded, each from ./fonts/ with HTTP 200.
 *   external   no request leaves localhost (every other host is aborted and listed).
 *   offline    context.setOffline(true) + reload: the page comes from the service worker, the game
 *              renders (7 letters), a letter tap types it, and the fonts are still loaded.
 *   update     online again, the server publishes a changed index.html: one reload shows it.
 *   badpub     the server answers index.html with 500: the reload shows the last good copy.
 *   slow       the server holds index.html for 8 s: the reload shows the cached copy in < 6 s.
 *   errors     no pageerror and no console.error anywhere above (offline-only "Failed to load resource"
 *              lines are listed, not failed, since the browser logs them for the network attempt).
 * Exit 0 all PASS, 1 any FAIL, 2 setup problem.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = '/letter-flower/';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.css': 'text/css',
};
const FONT_FILES = ['fonts/andika-latin-400.woff2', 'fonts/andika-latin-700.woff2', 'fonts/baloo2-latin-600.woff2', 'fonts/baloo2-latin-800.woff2'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Server knobs the checks flip: what index.html looks like right now.
const mode = { index: 'normal' };   // normal | updated | error | slow
const served = [];                  // [status, path]

function serve(req, res) {
  const u = new URL(req.url, 'http://x');
  let p = decodeURIComponent(u.pathname);
  const done = (code, body, type, extra) => {
    served.push([code, p]);
    res.writeHead(code, Object.assign({ 'Content-Type': type || 'text/plain', 'Cache-Control': 'max-age=600' }, extra || {}));
    res.end(body);
  };
  if (!p.startsWith(BASE)) return done(404, 'not under ' + BASE);
  let rel = p.slice(BASE.length) || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || /(^|\/)\./.test(rel) || rel.startsWith('node_modules')) return done(403, 'no');
  fs.readFile(file, (err, buf) => {
    if (err) return done(404, 'not found');
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    if (rel === 'index.html') {
      if (mode.index === 'error') return done(500, 'publish broke');
      if (mode.index === 'updated') buf = Buffer.from(buf.toString().replace('</body>', '<i id="build-marker" hidden>2</i></body>'));
      if (mode.index === 'slow') return setTimeout(() => done(200, buf, type), 8000);
    }
    done(200, buf, type);
  });
}

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail || '' }); };

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (e) { console.error('playwright not installed'); process.exit(2); }
  const server = http.createServer(serve);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, 'localhost', resolve); });
  } catch (e) { console.error('cannot bind a localhost port: ' + e.message); process.exit(2); }
  const port = server.address().port;
  const origin = `http://localhost:${port}`;
  const appUrl = origin + BASE;
  console.log(`serving ${ROOT} at ${appUrl}`);

  const browser = await chromium.launch({ args: ['--disable-gpu', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    viewport: { width: 412, height: 760 }, screen: { width: 412, height: 915 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 2.625,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    serviceWorkers: 'allow',
  });
  const external = new Set();
  await context.route(url => !url.href.startsWith(origin), route => { external.add(route.request().url()); return route.abort(); });

  const errors = [], offlineNoise = [];
  let phase = 'online';
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(`[${phase}] pageerror: ${e.message || e}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = `[${phase}] console.error: ${m.text()}`;
    const at = (m.location() || {}).url || '';
    if (/Failed to load resource/.test(m.text()) && at && !at.startsWith(origin)) return;  // reported by "no external requests"
    if (phase === 'offline' && /Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text())) offlineNoise.push(t);
    else errors.push(t);
  });
  const fontResponses = {};
  page.on('response', r => { if (/\/fonts\/[^/]+\.woff2$/.test(r.url())) fontResponses[r.url().split('/').pop()] = r.status(); });

  const fontState = () => page.evaluate(async () => {
    const want = [['Andika', '400'], ['Andika', '700'], ['Baloo 2', '600'], ['Baloo 2', '800']];
    await Promise.all(want.map(([f, w]) => document.fonts.load(`${w} 20px "${f}"`).catch(() => null)));
    await document.fonts.ready;
    const faces = [...document.fonts];
    return want.map(([f, w]) => {
      const face = faces.find(x => x.family.replace(/"/g, '') === f && String(x.weight) === w);
      return { f, w, status: face ? face.status : 'no @font-face', check: document.fonts.check(`${w} 20px "${f}"`) };
    });
  });
  const tapCentre = async () => {
    const before = await page.evaluate(() => window.Game.state().typed);
    const box = await page.locator('.flower button.m').boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(200);
    const after = await page.evaluate(() => window.Game.state().typed);
    const c = await page.evaluate(() => document.querySelector('.flower button.m').textContent.trim());
    return { before, after, c, ok: after === before + c };
  };
  const reload = async () => { const r = await page.reload({ waitUntil: 'load' }); await sleep(400); return r; };

  try {
    // ---- first load ----
    const r0 = await page.goto(appUrl, { waitUntil: 'load' });
    check('load', r0 && r0.status() === 200, `GET ${BASE} -> ${r0 && r0.status()}`);
    await sleep(400);

    // ---- manifest ----
    const man = await page.evaluate(async () => {
      const link = document.querySelector('link[rel=manifest]');
      if (!link) return { err: 'no <link rel=manifest>' };
      const res = await fetch(link.href);
      let m; try { m = JSON.parse(await res.text()); } catch (e) { return { err: 'manifest JSON: ' + e.message, status: res.status }; }
      const icons = [];
      for (const ic of m.icons || []) {
        const url = new URL(ic.src, link.href).href;
        const img = new Image(); img.src = url;
        let loaded = true; try { await img.decode(); } catch (e) { loaded = false; }
        icons.push({ src: ic.src, sizes: ic.sizes, purpose: ic.purpose || 'any', loaded, got: `${img.naturalWidth}x${img.naturalHeight}` });
      }
      return { status: res.status, type: res.headers.get('content-type'), m, icons, href: link.href };
    });
    if (man.err) check('manifest parses', false, man.err);
    else {
      const m = man.m;
      check('manifest parses', man.status === 200, `${man.href} ${man.status} ${man.type}`);
      const f = [];
      for (const k of ['id', 'start_url', 'scope']) if (m[k] !== './') f.push(`${k}=${JSON.stringify(m[k])}`);
      if (m.name !== 'Letter Flower' || m.short_name !== 'Letter Flower') f.push('name/short_name');
      if (!['standalone', 'fullscreen'].includes(m.display)) f.push('display=' + m.display);
      if (m.orientation !== 'portrait') f.push('orientation=' + m.orientation);
      if (!/^#[0-9a-f]{6}$/i.test(m.background_color || '') || !/^#[0-9a-f]{6}$/i.test(m.theme_color || '')) f.push('colours');
      check('manifest fields', !f.length, f.length ? f.join(', ') : `display=${m.display} orientation=${m.orientation} bg=${m.background_color} theme=${m.theme_color}`);
      const bad = man.icons.filter(i => !i.loaded || i.got !== i.sizes);
      check('manifest icons load', man.icons.length >= 3 && !bad.length && man.icons.some(i => /maskable/.test(i.purpose)),
        man.icons.map(i => `${i.src} ${i.purpose} ${i.loaded ? i.got : 'FAILED'}`).join('; '));
    }
    const cdp = await context.newCDPSession(page);
    try {
      const am = await cdp.send('Page.getAppManifest');
      check('chromium manifest errors', !(am.errors || []).length, (am.errors || []).map(e => e.message).join('; ') || 'none');
    } catch (e) { check('chromium manifest errors', true, 'Page.getAppManifest unavailable: ' + e.message); }
    try {
      const ie = await cdp.send('Page.getInstallabilityErrors');
      const list = (ie.installabilityErrors || []).map(e => e.errorId);
      check('installable', !list.length, list.join(', ') || 'no installability errors');
    } catch (e) { check('installable', true, 'Page.getInstallabilityErrors unavailable: ' + e.message); }

    // ---- service worker ----
    const sw = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { err: 'no navigator.serviceWorker' };
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(r, 10000))]);
      if (!reg) return { err: 'not ready after 10 s' };
      const w = reg.active;
      if (w && w.state !== 'activated') await new Promise(r => { w.addEventListener('statechange', () => w.state === 'activated' && r()); setTimeout(r, 5000); });
      return { scope: reg.scope, script: w && w.scriptURL, state: w && w.state };
    });
    check('sw registers + activates', !sw.err && sw.state === 'activated', sw.err || `${sw.script} scope ${sw.scope} ${sw.state}`);
    await reload();
    const ctl = await page.evaluate(() => !!navigator.serviceWorker.controller);
    check('sw controls page after reload', ctl, String(ctl));
    const caches_ = await page.evaluate(async () => {
      const out = {};
      for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map(r => new URL(r.url).pathname);
      return out;
    });
    const names = Object.keys(caches_), all = [].concat(...Object.values(caches_));
    // Fonts are required in the cache only if they are on disk; their absence is the fonts row's FAIL.
    const need = ['index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
      ...FONT_FILES.filter(f => fs.existsSync(path.join(ROOT, f)))];
    const missing = need.filter(n => !all.includes(BASE + n));
    const variants = all.filter(p => p.includes('/variants/'));
    check('sw cache contents', names.length === 1 && names[0].startsWith('letter-flower-') && !missing.length && !variants.length,
      `${names.join(',')}: ${all.length} entries` + (missing.length ? `; missing ${missing.join(', ')}` : '') + (variants.length ? `; variants cached: ${variants.join(', ')}` : ''));

    // ---- fonts (online) ----
    const fs1 = await fontState();
    const badFonts = fs1.filter(x => x.status !== 'loaded');
    const fromDir = Object.entries(fontResponses);
    const onDisk = FONT_FILES.filter(f => fs.existsSync(path.join(ROOT, f))).length;
    check('fonts load from ./fonts', !badFonts.length && fromDir.length >= 4 && fromDir.every(([, s]) => s === 200),
      `${onDisk}/4 woff2 on disk; ` + fs1.map(x => `${x.f} ${x.w} ${x.status}`).join(', ') + ' | ' + fromDir.map(([n, s]) => `${n} ${s}`).join(', '));
    const t1 = await tapCentre();
    check('letter types (online)', t1.ok, `"${t1.before}" -> "${t1.after}"`);

    // ---- offline ----
    phase = 'offline';
    await context.setOffline(true);
    const r1 = await reload();
    const game = await page.evaluate(() => ({
      letters: document.querySelectorAll('.flower button').length,
      title: (document.querySelector('.lvl') || {}).textContent || '',
      state: !!(window.Game && window.Game.state()),
    }));
    check('offline reload renders', r1 && r1.fromServiceWorker() && game.letters === 7 && game.state,
      `status ${r1 && r1.status()} fromServiceWorker=${r1 && r1.fromServiceWorker()} letters=${game.letters} title="${game.title.trim().replace(/\s+/g, ' ')}"`);
    const t2 = await tapCentre();
    check('letter types (offline)', t2.ok, `"${t2.before}" -> "${t2.after}"`);
    const fs2 = await fontState();
    check('fonts loaded (offline)', fs2.every(x => x.status === 'loaded'), fs2.map(x => `${x.f} ${x.w} ${x.status}`).join(', '));
    await context.setOffline(false);
    phase = 'online';

    // ---- a later publish reaches the next launch ----
    mode.index = 'updated';
    await reload();
    const marker = await page.evaluate(() => !!document.getElementById('build-marker'));
    check('update shows on next load', marker, `build marker present=${marker}`);

    mode.index = 'error';
    const r3 = await reload();
    const g3 = await page.evaluate(() => document.querySelectorAll('.flower button').length);
    check('bad publish (500) falls back', r3 && r3.status() === 200 && g3 === 7, `status ${r3 && r3.status()} letters=${g3}`);

    mode.index = 'slow';
    const t0 = Date.now();
    const r4 = await page.reload({ waitUntil: 'load' });
    const dt = Date.now() - t0;
    const g4 = await page.evaluate(() => document.querySelectorAll('.flower button').length);
    check('slow network falls back', dt < 6000 && g4 === 7, `${dt} ms, status ${r4 && r4.status()} letters=${g4}`);
    mode.index = 'normal';
    await sleep(4500);  // let the held response finish before closing

    check('no external requests', !external.size, external.size ? [...external].join(', ') : 'none');
  } catch (e) {
    check('run', false, (e && e.stack) || String(e));
  }
  check('no console errors', !errors.length, errors.length ? errors.join(' | ') : 'none');

  await browser.close();
  server.close();

  const w = Math.max(...results.map(r => r.name.length));
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail}`);
  if (offlineNoise.length) console.log(`note: ${offlineNoise.length} offline network line(s) not counted: ${offlineNoise.join(' | ')}`);
  const fail = results.filter(r => !r.ok).length;
  console.log(fail ? `OVERALL: FAIL (${fail})` : 'OVERALL: PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
