/* =========================================================
   EVA TRADING JOURNAL — SERVICE WORKER
   App-shell caching for install/offline support. Firebase
   auth, Firestore, and any other cross-origin/live-data
   traffic is NEVER intercepted or cached — it always goes
   straight to the network.
   ========================================================= */

// Bump this on every deploy that changes any cached file. Old caches
// are removed automatically on activate, so stale versions can never
// linger and serve outdated app-shell files.
const SW_VERSION = 'v1';
const CACHE_NAME = `eva-shell-${SW_VERSION}`;

// The app shell: same-origin, static, non-sensitive files only.
// No trade data, no journal entries, no auth/session data ever
// passes through this list — that all lives in Firebase and is
// fetched fresh, never cached here.
const APP_SHELL = [
  'dashboard.html',
  'journal.html',
  'analyze.html',
  'accounts.html',
  'settings.html',
  'challenge.html',
  'login.html',
  'signup.html',
  'forgot-password.html',
  'layout.html',
  'eva-loader.js',
  'dashboard.js',
  'journal.js',
  'analyze.js',
  'settings.js',
  'challenge.js',
  'manifest.json',
  'eva-icon.png',
  'eva-icon-logo.png',
  'eva-logo-dark.png',
  'eva-logo-light.png',
  'full.png',
  'icons/icon-72.png',
  'icons/icon-96.png',
  'icons/icon-128.png',
  'icons/icon-144.png',
  'icons/icon-152.png',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-384.png',
  'icons/icon-512.png',
  'icons/maskable-192.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-16.png',
  'icons/favicon-32.png'
];

// Resolve every shell path against this service worker's own location
// (not against '/') so the whole thing keeps working unchanged
// whether the site is deployed at a domain root or under a
// sub-path/sub-folder.
const APP_SHELL_URLS = APP_SHELL.map((path) => new URL(path, self.location.href).href);

// ---------- INSTALL ----------
// Pre-cache the app shell. Individual failures (a file that 404s,
// a slow network) must not abort the whole install, so each file
// is cached independently.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        APP_SHELL_URLS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] Skipped caching (not fatal):', url, err);
          })
        )
      )
    )
  );
  // Do NOT self.skipWaiting() here automatically — see the message
  // handler below. This lets the page control exactly when a new
  // shell version takes over, avoiding a mid-session swap that
  // could interrupt an open trade entry or journal edit.
});

// ---------- ACTIVATE ----------
// Remove any caches from older versions so a stale shell can never
// be served, then take control of open clients.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('eva-shell-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

// Allow the page to trigger an immediate takeover once it has
// decided it's safe to do so (see the registration script, which
// prompts to reload when an update is found).
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ---------- HELPERS ----------
function isFirebaseOrLiveData(url) {
  // Anything not on this exact origin (Firebase Auth, Firestore,
  // Firebase Storage, gstatic Firebase SDK modules, Google Fonts,
  // analytics, CDN scripts like ECharts, etc.) is left completely
  // untouched by this service worker.
  return url.origin !== self.location.origin;
}

function isAppShellRequest(url) {
  if (url.origin !== self.location.origin) return false;
  // Compare ignoring query string so cache-busting params on a
  // static asset still hit the right cached entry.
  const bare = url.origin + url.pathname;
  return APP_SHELL_URLS.some((shellUrl) => shellUrl.split('?')[0] === bare);
}

// ---------- FETCH ----------
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only ever handle GET requests for our own origin's static shell.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never intercept cross-origin requests: Firebase Auth/Firestore/
  // Storage, the Firebase SDK modules from gstatic, Google Fonts,
  // any CDN (e.g. ECharts), analytics, etc. These always hit the
  // network live so trading data and auth state are never stale
  // or served from cache.
  if (isFirebaseOrLiveData(url)) return;

  // HTML navigations: network-first so users always see the latest
  // deployed page and data-affecting markup, falling back to the
  // cached shell only when there is no connection at all. This is
  // what prevents a stale/blank screen if the network is flaky —
  // there is always a last-known-good page to fall back to.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, fresh.clone());
          return fresh;
        } catch (err) {
          const cached = await caches.match(request);
          if (cached) return cached;
          const dashboard = await caches.match('dashboard.html');
          if (dashboard) return dashboard;
          throw err;
        }
      })()
    );
    return;
  }

  // Static app-shell assets (JS/CSS/images/icons/manifest): cache-
  // first for instant loads, refreshing the cache in the background
  // so the next load picks up any change without ever blocking this
  // one on the network.
  if (isAppShellRequest(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        const networkFetch = fetch(request)
          .then((response) => {
            if (response && response.ok) {
              caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
            }
            return response;
          })
          .catch(() => null);
        return cached || (await networkFetch) || new Response('', { status: 504 });
      })()
    );
    return;
  }

  // Everything else same-origin (not in the shell list) — just let
  // it go to the network as normal, no interception.
});
