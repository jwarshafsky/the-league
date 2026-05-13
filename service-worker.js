// service-worker.js — minimal PWA service worker.
//
// Strategy:
//   - Network-first for everything (so the existing ?v=N cache buster keeps
//     working: the latest deploy is always served when the user has signal).
//   - On network failure, fall back to cached responses (offline-tolerant).
//   - Never cache Supabase / external API requests.
//   - Auto-activate new versions immediately so users get updates without a
//     second reload.
//
// Bump CACHE_VERSION when changing the SW logic itself (not for app code —
// that's handled by ?v=N at the script tags).

const CACHE_VERSION = "the-league-v6";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./js/supabase-client.js",
  "./js/db.js",
  "./js/data.js",
  "./js/player-stats-snapshot.js",
  "./js/espn-snapshot.js",
  "./js/history-snapshot.js",
  "./js/prospects.js",
  "./js/app.js",
  "./js/rules-bot.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // Use addAll without throwing on individual failures — if one asset 404s,
      // the install still succeeds with the rest cached.
      Promise.all(
        STATIC_ASSETS.map((url) =>
          cache.add(url).catch((err) => console.warn("[sw] cache miss:", url, err))
        )
      )
    )
  );
  // Note: we do NOT call skipWaiting() here. The page will postMessage
  // {type:'SKIP_WAITING'} once it's safe (see message handler below) so the
  // controllerchange / reload sequence is deterministic.
});

// Page asks us to take over: do it. Triggers controllerchange in clients.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// --- Web Push ---
//
// Server (scripts/notify_*.py) sends JSON payloads with shape:
//   { title: "...", body: "...", url: "/the-league/?tab=trades&sub=inbox", tag: "..." }
// `tag` lets a newer notification of the same kind replace an older one.

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: (event.data && event.data.text()) || "" }; }
  const title = data.title || "The League";
  const options = {
    body: data.body || "",
    icon: "/the-league/icons/icon-192.png",
    badge: "/the-league/icons/icon-64.png",
    data: { url: data.url || "/the-league/" },
    tag: data.tag,
    renotify: !!data.tag,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Only follow URLs that stay on this origin (defense-in-depth against a
// malformed/spoofed push payload pointing at an off-site URL).
function _safeTargetUrl(raw) {
  const fallback = "/the-league/";
  if (!raw || typeof raw !== "string") return fallback;
  try {
    const u = new URL(raw, self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : fallback;
  } catch {
    return fallback;
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = _safeTargetUrl(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Re-use an open The League tab if one exists.
    for (const c of allClients) {
      if (c.url.includes("/the-league") && "focus" in c) {
        await c.focus();
        if ("navigate" in c) c.navigate(targetUrl).catch(() => {});
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});

// After caching a versioned asset like `app.js?v=183`, drop older `?v=N`
// entries for the same base path. Without this the cache accumulates one
// dead entry per deploy per asset forever (browser quota eventually evicts
// LRU, but it's wasted user storage in the meantime).
async function _evictStaleVersions(cache, freshUrl) {
  try {
    if (!freshUrl.searchParams.has("v")) return;
    const basePath = freshUrl.origin + freshUrl.pathname;
    const freshHref = freshUrl.href;
    const reqs = await cache.keys();
    await Promise.all(reqs.map(r => {
      try {
        const u = new URL(r.url);
        if (u.origin + u.pathname === basePath && u.href !== freshHref) {
          return cache.delete(r);
        }
      } catch {}
    }));
  } catch {}
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Don't intercept third-party / cross-origin / API traffic.
  // Supabase, Groq, ESPN CDN, etc. should always go straight to the network.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(req);
        // Cache successful same-origin responses for offline fallback.
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE_VERSION);
          cache.put(req, fresh.clone()).catch(() => {});
          _evictStaleVersions(cache, url);
        }
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE_VERSION);
        const cached = await cache.match(req);
        if (cached) return cached;
        // Last resort: serve the index for navigation requests so the SPA
        // shell loads even when the requested path isn't cached.
        if (req.mode === "navigate") {
          const indexCached = await cache.match("./index.html");
          if (indexCached) return indexCached;
        }
        throw e;
      }
    })()
  );
});
