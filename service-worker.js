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

const CACHE_VERSION = "the-league-v4";
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
  self.skipWaiting();
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
