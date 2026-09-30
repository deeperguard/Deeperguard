// Keep this file byte-stable across deploys. Embedding a build number here
// made Safari treat every release as a new worker and reload the open tab.
const CACHE = 'deeperguard-offline';
const SHELL = 'deeperguard-shell';
const APP_SHELL = '/app';
const PRECACHE = [
  APP_SHELL,
  '/ca.crt',
  '/manifest.json',
  '/static/js/vendor/noble-crypto.js',
  '/static/js/vendor/noble-argon2.js',
  // Pinned-version assets (never change per app build — safe in a byte-stable SW).
  '/static/js/vendor/pdfjs/pdf.min.js?v=8',
  '/static/js/vendor/pdfjs/pdf.worker.min.js?v=8',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
];

async function putBoth(url, response) {
  if (!response || !response.ok) return;
  const versioned = await caches.open(CACHE);
  const shell = await caches.open(SHELL);
  await versioned.put(url, response.clone());
  if (url === APP_SHELL || url === '/manifest.json') await shell.put(url, response.clone());
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            const res = await fetch(url, { credentials: 'same-origin', cache: 'reload' });
            await putBoth(url, res);
          } catch (err) {
            /* keep whatever is already cached */
          }
        }),
      );
      // Activate immediately so www.deeperguard.com stops serving a cached
      // notes shell. /app clients are not reloaded (see activate).
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL);
      const hasApp = await shell.match(APP_SHELL);
      if (!hasApp) {
        const keys = await caches.keys();
        for (const key of keys) {
          const old = await caches.open(key);
          const page = await old.match(APP_SHELL)
            || await old.match('/')
            || await old.match(new Request(APP_SHELL))
            || await old.match(new Request('/'));
          if (page) {
            await shell.put(APP_SHELL, page);
            break;
          }
        }
      }
      const keep = new Set([CACHE, SHELL]);
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => !keep.has(key)).map((key) => caches.delete(key)));
      // "/" is the marketing site. Drop any leftover notes-shell HTML stored there.
      for (const name of [CACHE, SHELL]) {
        try {
          const cache = await caches.open(name);
          const stored = await cache.keys();
          await Promise.all(stored.filter((req) => {
            try {
              return new URL(req.url, self.location.origin).pathname === '/';
            } catch (err) {
              return false;
            }
          }).map((req) => cache.delete(req)));
        } catch (err) {
          /* keep going */
        }
      }
      await self.clients.claim();
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      await Promise.all(windows.map((client) => {
        try {
          const url = new URL(client.url);
          if (url.pathname === '/' || url.pathname === '') {
            return client.navigate(`${url.origin}/`);
          }
        } catch (err) {
          /* ignore */
        }
        return undefined;
      }));
    })(),
  );
});

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

function isApi(url) {
  return url.pathname.startsWith('/api/');
}

function isAuthPage(url) {
  return url.pathname === '/login' || url.pathname === '/register' || url.pathname === '/totp';
}

function isMarketingPage(url) {
  const path = url.pathname;
  return path === '/' || path === ''
    || path === '/pricing' || path === '/privacy' || path === '/terms'
    || path === '/self-host' || path === '/robots.txt' || path === '/sitemap.xml';
}

function isAppShell(url) {
  return url.pathname === APP_SHELL || url.pathname === '/manifest.json';
}

async function matchCached(request) {
  const names = [SHELL, CACHE];
  for (const name of names) {
    try {
      const cache = await caches.open(name);
      const exact = await cache.match(request);
      if (exact) return exact;
      try {
        const loose = await cache.match(request, { ignoreSearch: true, ignoreVary: true });
        if (loose) return loose;
      } catch (err) {
        const loose = await cache.match(request, { ignoreSearch: true });
        if (loose) return loose;
      }
    } catch (err) {
      /* try next cache */
    }
  }
  try {
    const url = new URL(request.url, self.location.origin);
    if (url.pathname === APP_SHELL) {
      const shell = await caches.open(SHELL);
      return (await shell.match(APP_SHELL))
        || (await caches.match(APP_SHELL));
    }
  } catch (err) {
    /* ignore */
  }
  return undefined;
}

function refresh(request) {
  fetch(request, { credentials: 'same-origin', cache: 'reload' })
    .then((fresh) => {
      if (!fresh || !fresh.ok) return;
      putBoth(new URL(request.url).pathname === APP_SHELL ? APP_SHELL : request, fresh);
    })
    .catch(() => undefined);
}

async function networkFirstNavigate(request) {
  let hard = false;
  try {
    hard = new URL(request.url).searchParams.get('hard') === '1';
  } catch (err) {
    hard = false;
  }
  const timeoutMs = hard ? 8000 : 3500;
  try {
    const fresh = await Promise.race([
      fetch(request, { credentials: 'same-origin', cache: 'reload' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    if (fresh && fresh.ok) {
      let key = request;
      try {
        const url = new URL(request.url);
        if (url.pathname === APP_SHELL) key = APP_SHELL;
      } catch (err) {
        key = request;
      }
      await putBoth(key, fresh);
      return fresh;
    }
  } catch (err) {
    if (hard) {
      try {
        const forced = await fetch(request, { credentials: 'same-origin', cache: 'reload' });
        if (forced && forced.ok) {
          await putBoth(APP_SHELL, forced);
          return forced;
        }
      } catch (e2) {
        /* fall through */
      }
    }
    /* LAN is down — fall back to the last cached shell */
  }
  const cached = await matchCached(request);
  if (cached) return cached;
  const home = await matchCached(new Request(APP_SHELL));
  if (home) return home;
  // Never hand Safari a failed navigation — that becomes the Dutch
  // "problem occurred repeatedly" crash page when LAN is unreachable.
  return new Response(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Deeperguard — offline</title>'
    + '<style>'
    + '*,*::before,*::after{box-sizing:border-box}'
    + 'body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a;background:radial-gradient(1000px 400px at 50% -30px,#e0f2fe 0%,rgba(224,242,254,.4) 40%,transparent 80%),linear-gradient(180deg,#f8fafc 0%,#f1f5f9 100%)}'
    + '.card{width:min(420px,100%);padding:32px 24px 24px;border:1px solid #e2e8f0;border-radius:20px;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.05),0 10px 25px -5px rgba(15,23,42,.08);text-align:center}'
    + '.mark{width:56px;height:56px;margin:0 auto 12px;border-radius:14px;background:linear-gradient(145deg,#2563eb,#1d4ed8);display:grid;place-items:center;color:#fff;font-weight:800;font-size:22px;letter-spacing:-.04em}'
    + 'h1{margin:0 0 8px;font-size:24px;letter-spacing:-.02em}'
    + 'p{margin:0 0 18px;line-height:1.45;color:#64748b;font-size:15px}'
    + '.hint{margin:0 0 20px;padding:10px 12px;border-radius:10px;background:#ecfdf5;border:1px solid #bbf7d0;color:#166534;font-size:13px;line-height:1.4}'
    + 'button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border:0;border-radius:10px;background:#2563eb;color:#fff;font:inherit;font-weight:600;cursor:pointer}'
    + '</style></head><body>'
    + '<main class="card" role="main">'
    + '<div class="mark" aria-hidden="true">DG</div>'
    + '<h1>You\'re offline</h1>'
    + '<p class="hint">Notes are encrypted on your device. Reconnect to sync — we only store scrambled data on the server.</p>'
    + '<p>Join home Wi‑Fi or WireGuard, then reload Deeperguard.</p>'
    + '<button type="button" onclick="location.href=\'' + APP_SHELL + '\'">Reload</button>'
    + '</main></body></html>',
    {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    },
  );
}

async function cacheFirstNavigate(request) {
  // Accidental iOS document refetches must not swap in a new HTML build mid-browse.
  // Explicit Update uses ?nosync=1 and takes the network-first path.
  const cached = await matchCached(request);
  if (cached) {
    refresh(request);
    return cached;
  }
  return networkFirstNavigate(request);
}

async function matchExact(request) {
  for (const name of [CACHE, SHELL]) {
    try {
      const cache = await caches.open(name);
      const hit = await cache.match(request);
      if (hit) return hit;
    } catch (err) {
      /* try next cache */
    }
  }
  return undefined;
}

function isVersioned(url) {
  return url.searchParams.has('v');
}

async function cacheFirst(request, versioned) {
  // A ?v= asset must match its exact build. Falling back to a loose match would
  // pair freshly deployed HTML with the previous build's scripts, so every deploy
  // would appear to change nothing until a second reload swapped the worker.
  const cached = versioned ? await matchExact(request) : await matchCached(request);
  if (cached) {
    if (!versioned) refresh(request);
    return cached;
  }
  try {
    const fresh = await fetch(request, { credentials: 'same-origin' });
    if (fresh && fresh.ok) {
      const cache = await caches.open(CACHE);
      await cache.put(request, fresh.clone());
    }
    if (fresh) return fresh;
  } catch (err) {
    /* offline — fall back to whatever build is cached */
  }
  const stale = await matchCached(request);
  if (stale) return stale;
  return fetch(request);
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    // Explicit Update tap — safe to activate now.
    self.skipWaiting();
    return;
  }
  if (data.type !== 'notes-build-ping') return;
  const port = event.ports && event.ports[0];
  if (port) port.postMessage({ cache: CACHE });
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag !== 'notes-sync') return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage({ type: 'notes-periodic-sync' });
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }
  if (!sameOrigin(url) || isApi(url) || isAuthPage(url) || isMarketingPage(url)) return;

  if (request.mode === 'navigate' || isAppShell(url)) {
    const forceFresh = url.searchParams.get('nosync') === '1' || url.searchParams.get('hard') === '1';
    event.respondWith(forceFresh ? networkFirstNavigate(request) : cacheFirstNavigate(request));
    return;
  }
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(cacheFirst(request, isVersioned(url)));
  }
});
