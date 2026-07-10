/* HisaabNow service worker — NETWORK-FIRST (with timeout) for the HTML shell.
 *
 * Why network-first: this app is online-dependent and redeployed often. The
 * HTML must always be the freshest build when the network is available, so a
 * new deploy shows up on the next open with no manual cache clear — and a bad
 * cached copy can never trap the app, because every online load goes to the
 * network first and overwrites the cache. The cached copy is used ONLY as an
 * offline / slow-network fallback (after NAV_TIMEOUT), so it is not the
 * "wait for the whole 3.8MB before anything renders" experience.
 *
 * DEPLOY RULE: bump SW_VERSION every deploy (set it to window.HISAABNOW_BUILD).
 */

const SW_VERSION  = 'v33_461_ordertype_prompt';
const CACHE       = 'hisaabnow-' + SW_VERSION;
const NAV_TIMEOUT = 4000; /* ms before falling back to cached HTML */

self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
                            .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (event) {
  if (event.data === 'SKIP_WAITING' || (event.data && event.data.type === 'SKIP_WAITING')) {
    self.skipWaiting();
  }
});

function fetchWithTimeout(req, ms) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; reject(new Error('timeout')); } }, ms);
    fetch(req).then(function (res) {
      if (done) return; done = true; clearTimeout(timer); resolve(res);
    }).catch(function (err) {
      if (done) return; done = true; clearTimeout(timer); reject(err);
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;                 /* Firebase, PayU, CDNs pass through */
  if (url.pathname.indexOf('firebase-messaging-sw') !== -1) return; /* FCM worker manages itself */

  var accept = req.headers.get('accept') || '';
  var isNavigation =
    req.mode === 'navigate' ||
    accept.indexOf('text/html') !== -1 ||
    url.pathname === '/' ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('/index.html');

  /* HTML document -> NETWORK-FIRST with timeout, cache only as offline fallback. */
  if (isNavigation) {
    event.respondWith(
      fetchWithTimeout(req, NAV_TIMEOUT).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put('./index.html', copy); }).catch(function () {});
        }
        return res;
      }).catch(function () {
        /* offline or network stalled past NAV_TIMEOUT -> last good copy */
        return caches.match('./index.html').then(function (m) {
          return m || caches.match(req) || fetch(req);
        });
      })
    );
    return;
  }

  /* Other same-origin GETs (manifest, icons) -> cache-first, refresh in background. */
  event.respondWith(
    caches.match(req).then(function (cached) {
      var net = fetch(req).then(function (res) {
        if (res && res.status === 200 && (res.type === 'basic' || res.type === 'default')) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      }).catch(function () { return cached; });
      return cached || net;
    })
  );
});
