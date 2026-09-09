/* Bump the version to invalidate every cached asset after a breaking layout change. */
const CACHE = "sf-world-v5";
const MAX_ENTRIES = 500;

/* Vite content-hashed code is safe to serve from cache forever. */
const CACHE_FIRST = ["/assets/"];
// Public names may point at a different immutable R2 object in the next release.
// Let HTTP revalidate these names; only hashed URLs are safe to cache forever.
const NETWORK_FIRST = ["/fonts/", "/audio/", "/models/", "/citygen/"];
/* Rebaked in place under the same URL: validate the release before reuse. */
const REVALIDATE = ["/tiles/", "/data/"];

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    })()
  );
});

/* Never cache opaque, partial, or error responses — a poisoned entry persists across loads. */
const cacheable = (response) => !!response && response.status === 200 && response.type === "basic";

async function trimCache(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_ENTRIES; i++) await cache.delete(keys[i]);
}

/* waitUntil keeps the worker alive for the put + trim without delaying the response. */
function putInBackground(event, cache, request, response) {
  event.waitUntil(
    cache.put(request, response.clone()).then(() => trimCache(cache)).catch(() => {})
  );
}

async function cacheFirst(event, request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (cacheable(response)) putInBackground(event, cache, request, response);
  return response;
}

async function networkFirst(event, request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (cacheable(response)) putInBackground(event, cache, request, response);
    return response;
  } catch (error) {
    const hit = await cache.match(request, { ignoreVary: true });
    if (hit) return hit;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.mode === "navigate" || request.destination === "document") return;
  if (request.headers.has("range")) return;
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (path === "/ws" || path === "/healthz") return;
  let handler = null;
  if (path === "/native-foliage/manifest.json") handler = networkFirst;
  else if (path.startsWith("/native-foliage/")) handler = networkFirst;
  else if (NETWORK_FIRST.some((prefix) => path.startsWith(prefix))) handler = networkFirst;
  else if (CACHE_FIRST.some((prefix) => path.startsWith(prefix))) handler = cacheFirst;
  else if (REVALIDATE.some((prefix) => path.startsWith(prefix))) handler = networkFirst;
  if (!handler) return;
  event.respondWith(
    handler(event, request)
      .catch(() => fetch(request))
      .catch(() => Response.error())
  );
});
