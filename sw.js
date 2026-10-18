/* Letter Flower service worker.
 *
 * Hosted under a sub-path (GitHub Pages /letter-flower/), so every URL here is relative to this file.
 * The whole game (HTML, CSS, JS) is the one file index.html; the other precached files are static assets.
 *
 *   - App page (./ or ./index.html), navigations: NETWORK FIRST, so a published update shows on the next
 *     launch. A response that has not arrived within NAV_TIMEOUT_MS is answered from the cache instead
 *     (a phone on weak signal must not leave a child on a blank screen); the network copy still refreshes
 *     the cache in the background for the launch after. No network and no cache: the browser's error.
 *   - Precached assets (manifest, icons, fonts): CACHE FIRST (a miss is fetched and stored).
 *     The page, manifest and icons must precache or the worker does not install. The ./fonts/ files are
 *     precached best-effort: they are not in the tree until someone downloads them (fonts/README.txt).
 *   - Google Fonts (fallback while index.html still links them): the stylesheet is stale-while-revalidate,
 *     the font files cache first. At install the stylesheet and its latin font files are fetched once,
 *     best-effort, so the app has its fonts offline from the first launch after install.
 *   - Everything else (variants/, letter-flower.html, other sites): not intercepted and never cached.
 *
 * Publishing: a change to index.html alone needs nothing here. A change to a font, an icon or the
 * manifest needs VERSION bumped, or phones keep the old asset. skipWaiting/claim are safe because there
 * is no other code that could be out of step with the page: a new worker takes over at once.
 */
'use strict';
const VERSION = 'v1';
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
const GOOGLE_CSS = 'https://fonts.googleapis.com/css2?family=Andika:wght@400;700&family=Baloo+2:wght@600;800&display=swap';
const GOOGLE_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

const abs = p => new URL(p, self.registration.scope).href;
const scopePath = () => new URL(self.registration.scope).pathname;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache:'reload' skips the HTTP cache so a new version never precaches a stale copy.
    await cache.addAll([PAGE, ...CORE].map(p => new Request(p, { cache: 'reload' })));
    await Promise.allSettled(FONTS.map(p => cache.add(new Request(p, { cache: 'reload' }))));
    await precacheGoogleFonts(cache).catch(() => {});
    await self.skipWaiting();
  })());
});

// Fallback only, and harmless but wasted (~100 KB) once index.html stops linking Google Fonts: delete this
// function, its call and the googleFont branch then, and bump VERSION. Fails quietly offline.
async function precacheGoogleFonts(cache) {
  const res = await fetch(GOOGLE_CSS);   // CORS-enabled, so its text is readable
  if (!res.ok) return;
  await cache.put(GOOGLE_CSS, res.clone());
  const css = await res.text();
  const latin = css.split('/* ').filter(b => b.startsWith('latin */')).join('\n');
  const urls = [...latin.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(m => m[1]);
  await Promise.allSettled(urls.map(u => cache.add(u)));
}

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

async function appPage(request) {
  const cache = await caches.open(CACHE);
  const network = fetch(request, { cache: 'no-cache' }).then(res => {
    if (res.ok) return cache.put(abs(PAGE), res.clone()).then(() => res);
    return res;
  });
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(resolve, NAV_TIMEOUT_MS, 'timeout'); });
  try {
    const first = await Promise.race([network, timeout]);
    if (first !== 'timeout') {
      if (first.ok) return first;
      // A 404/500 from a bad publish: keep the child on the last working copy if there is one.
      return (await cache.match(abs(PAGE))) || first;
    }
    const cached = await cache.match(abs(PAGE));
    if (cached) { network.catch(() => {}); return cached; }
    return await network;
  } catch (e) {
    const cached = await cache.match(abs(PAGE));
    if (cached) return cached;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (GOOGLE_HOSTS.includes(url.hostname)) { event.respondWith(googleFont(event, req, url)); return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(scopePath() + 'variants/')) return;   // never cached, never intercepted
  if (req.mode === 'navigate' || isAppPage(url)) {
    if (isAppPage(url)) event.respondWith(appPage(req));
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

async function googleFont(event, req, url) {
  if (url.hostname === 'fonts.gstatic.com') return cacheFirst(req, req.url);
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req.url, { ignoreVary: true });
  const net = fetch(req).then(res => {
    if (res.ok || res.type === 'opaque') return cache.put(req.url, res.clone()).then(() => res);
    return res;
  });
  if (hit) { event.waitUntil(net.catch(() => {})); return hit; }
  return net;
}
