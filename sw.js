/* Letter Flower service worker.
 *
 * Hosted under a sub-path (GitHub Pages /letter-flower/), so every URL here is relative to this file.
 * The whole game (HTML, CSS, JS) is the one file index.html; the other precached files are static assets.
 *
 *   - App page (./ or ./index.html), navigations: NETWORK FIRST, so a published update shows on the next
 *     launch. A response that has not arrived within NAV_TIMEOUT_MS is answered from the cache instead
 *     (a phone on weak signal must not leave a child on a blank screen); the network copy still refreshes
 *     the cache in the background. The cache is also used on a network error or a 5xx; a redirect or a
 *     4xx is shown as the server sent it (see appPage). No network and no cache: the browser's error.
 *   - Resume from Recents: index.html calls registration.update() and posts 'lf-check' when it becomes
 *     visible again. A changed page (or a new worker) makes it reload once the typed word is empty and
 *     the menu is closed, never mid-word.
 *   - Precached assets (manifest, icons, the self-hosted ./fonts/*.woff2): CACHE FIRST (a miss is fetched
 *     and stored). The page and every asset must precache or the new worker does not install, so the old
 *     worker and its complete cache stay in charge: a VERSION bump can never leave a phone without its fonts.
 *   - Everything else (variants/, letter-flower.html, other sites): not intercepted and never cached.
 *
 * Publishing: a change to index.html alone needs nothing here. A change to a font, an icon or the
 * manifest needs VERSION bumped, or phones keep the old asset. skipWaiting/claim are safe because there
 * is no other code that could be out of step with the page: a new worker takes over at once.
 * Two traps: (1) assets are cached under their URL WITHOUT the query string, so '?v=2' cache-busting does
 * nothing here: bump VERSION. (2) Only the files listed in ASSETS are cached; a new same-origin file
 * that index.html starts to use (a sound, an image) must be added to CORE or it breaks offline.
 */
'use strict';
const VERSION = 'v2';                     // v2: self-hosted fonts, Google Fonts branch removed
const PREFIX = 'letter-flower-';          // the github.io origin is shared with other repos: touch only our caches
const CACHE = PREFIX + VERSION;
const NAV_TIMEOUT_MS = 4000;
const PAGE = './index.html';
const CORE = [
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];
const FONTS = [
  './fonts/andika-latin-400.woff2',
  './fonts/andika-latin-700.woff2',
  './fonts/baloo2-latin-600.woff2',
  './fonts/baloo2-latin-800.woff2',
];
const ASSETS = [...CORE, ...FONTS];

const abs = p => new URL(p, self.registration.scope).href;
const scopePath = () => new URL(self.registration.scope).pathname;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache:'reload' skips the HTTP cache so a new version never precaches a stale copy.
    await cache.addAll([PAGE, ...ASSETS].map(p => new Request(p, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

function isAppPage(url) {
  const s = scopePath();
  return url.origin === self.location.origin && (url.pathname === s || url.pathname === s + 'index.html');
}

// The cache's copy of the page is kept equal to what the open pages show. When a fresh copy that differs
// is stored, every open page except `skipClient` (the one already showing it) is told 'lf-page-updated',
// and index.html reloads at a safe moment (empty word, menu closed). A failed put is not fatal: the fresh
// copy is still what the page gets.
async function storePage(res, skipClient) {
  const body = await res.text();
  const cache = await caches.open(CACHE);
  const old = await cache.match(abs(PAGE));
  if (old && (await old.text()) === body) return;
  await cache.put(abs(PAGE), new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers }))
    .catch(() => {});
  if (!old) return;
  for (const c of await self.clients.matchAll({ type: 'window' })) if (c.id !== skipClient) c.postMessage({ type: 'lf-page-updated' });
}

// Answered from the network when it answers within NAV_TIMEOUT_MS with anything but a 5xx: a 200 is shown
// and stored; a redirect (an opaqueredirect, since a navigation keeps redirect:'manual') or a 4xx is shown
// as is, so a moved or removed app is never pinned to its old copy with no way out. The cached copy is shown
// on a network error, a 5xx (a bad publish) or a timeout; after a timeout the network copy still lands in
// the cache, kept alive by waitUntil, and the page is told if it changed.
async function appPage(event) {
  const network = fetch(event.request, { cache: 'no-cache' });
  let timer, first;
  const timeout = new Promise(resolve => { timer = setTimeout(resolve, NAV_TIMEOUT_MS, 'timeout'); });
  try { first = await Promise.race([network, timeout]); } catch (e) { first = 'error'; } finally { clearTimeout(timer); }
  if (first !== 'timeout' && first !== 'error') {
    if (first.ok) { event.waitUntil(storePage(first.clone(), event.resultingClientId).catch(() => {})); return first; }
    if (first.type === 'opaqueredirect' || first.status < 500) return first;
  }
  const cached = await (await caches.open(CACHE)).match(abs(PAGE));
  if (first === 'timeout') {
    event.waitUntil(network.then(res => res.ok ? storePage(res, null) : null).catch(() => {}));
    return cached || network;
  }
  if (cached) return cached;
  return first === 'error' ? network : first;   // nothing cached: the browser's own error, or the 5xx
}

// index.html posts 'lf-check' when the app comes back to the foreground (resumed from Recents, where no
// navigation happens). A changed page is stored and announced as above.
self.addEventListener('message', event => {
  if (!event.data || event.data.type !== 'lf-check') return;
  event.waitUntil(fetch(abs(PAGE), { cache: 'no-cache' })
    .then(res => res.ok && !res.redirected ? storePage(res, null) : null).catch(() => {}));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(scopePath() + 'variants/')) return;   // never cached, never intercepted
  if (req.mode === 'navigate' || isAppPage(url)) {
    if (isAppPage(url)) event.respondWith(appPage(event));
    return;
  }
  const href = url.origin + url.pathname;
  if (!ASSETS.some(p => abs(p) === href)) return;
  event.respondWith(cacheFirst(req, href));
});

async function cacheFirst(req, key) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(key, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(key, res.clone()).catch(() => {});
  return res;
}
