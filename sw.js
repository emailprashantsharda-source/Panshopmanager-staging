// hisaabnow service worker — v27.10
// 
// Strategy:
//   - Network-first for index.html (HTML navigation requests)
//     ensures users always get latest app code when online
//   - Cache-first for static assets (icons, manifest)
//     instant return-visit loads
//   - Kill switch: if KILL_VERSION is bumped, all caches wiped
//     and SW unregisters itself — recovery from broken deploys
//
// SAFETY: To kill this SW for all users, bump KILL_VERSION below
// and redeploy. All clients will detect the new version, clear
// caches, unregister themselves on next page load.

const CACHE_VERSION = 'hisaabnow-v27.10';
const KILL_VERSION = 0; // bump this number to force-kill all SWs

const STATIC_CACHE = CACHE_VERSION + '-static';
const HTML_CACHE = CACHE_VERSION + '-html';

// Resources to pre-cache on install (must succeed for SW to install)
const PRECACHE_URLS = [
  './manifest.json',
];

// On install, pre-cache static assets and skip waiting (activate immediately)
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(function(cache) {
      return cache.addAll(PRECACHE_URLS).catch(function(e) {
        console.warn('[SW] precache partial failure:', e);
      });
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// On activate, delete old caches and claim all clients
self.addEventListener('activate', function(event) {
  event.waitUntil(
    Promise.all([
      // Delete any cache that doesn't match current version
      caches.keys().then(function(keys) {
        return Promise.all(keys.map(function(key) {
          if (key.indexOf(CACHE_VERSION) === -1) {
            console.log('[SW] deleting old cache:', key);
            return caches.delete(key);
          }
        }));
      }),
      // Claim all clients so this SW controls them immediately
      self.clients.claim()
    ])
  );
});

// Kill switch: if KILL_VERSION > 0, unregister and clear everything
if (KILL_VERSION > 0) {
  self.addEventListener('install', function(event) {
    event.waitUntil(
      caches.keys().then(function(keys) {
        return Promise.all(keys.map(function(k) { return caches.delete(k); }));
      }).then(function() {
        return self.registration.unregister();
      }).then(function() {
        return self.clients.matchAll();
      }).then(function(clients) {
        clients.forEach(function(c) { c.navigate(c.url); });
      })
    );
  });
}

// Fetch handler: network-first for HTML, cache-first for static
self.addEventListener('fetch', function(event) {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Don't cache POST, PUT, DELETE etc. — only GET
  if (req.method !== 'GET') return;

  // Don't cache requests with query strings (debug=1, etc.) — let them go through
  if (url.search) return;

  // Don't cache Firebase, Firestore, GAPI requests
  if (url.hostname.indexOf('firebase') > -1 ||
      url.hostname.indexOf('googleapis') > -1 ||
      url.hostname.indexOf('gstatic') > -1) return;

  // HTML navigation: network-first with cache fallback
  // This ensures users get the latest code when online but still
  // works offline (last cached version)
  const acceptHeader = req.headers.get('accept') || '';
  const isHTML = req.mode === 'navigate' ||
                 acceptHeader.indexOf('text/html') > -1 ||
                 url.pathname === '/' ||
                 url.pathname.endsWith('.html') ||
                 url.pathname === '/index.html';

  if (isHTML) {
    event.respondWith(
      fetch(req).then(function(res) {
        // Cache the fresh response
        if (res && res.status === 200) {
          const resClone = res.clone();
          caches.open(HTML_CACHE).then(function(cache) {
            cache.put(req, resClone);
          });
        }
        return res;
      }).catch(function() {
        // Network failed, try cache
        return caches.match(req).then(function(cached) {
          return cached || caches.match('./index.html');
        });
      })
    );
    return;
  }

  // Static assets: cache-first with network fallback
  event.respondWith(
    caches.match(req).then(function(cached) {
      if (cached) {
        // Refresh in background (stale-while-revalidate for static)
        fetch(req).then(function(res) {
          if (res && res.status === 200) {
            caches.open(STATIC_CACHE).then(function(cache) {
              cache.put(req, res.clone());
            });
          }
        }).catch(function(){});
        return cached;
      }
      // Not in cache, fetch from network
      return fetch(req).then(function(res) {
        if (res && res.status === 200) {
          const resClone = res.clone();
          caches.open(STATIC_CACHE).then(function(cache) {
            cache.put(req, resClone);
          });
        }
        return res;
      });
    })
  );
});

// Allow page to send messages to SW (e.g., to force update)
self.addEventListener('message', function(event) {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (event.data === 'CLEAR_CACHES') {
    caches.keys().then(function(keys) {
      return Promise.all(keys.map(function(k) { return caches.delete(k); }));
    });
  }
});
