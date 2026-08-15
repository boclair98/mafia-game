const CACHE = "black-midnight-v6";
const SHELL = [
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/mafia-table-wide-v2.webp",
  "/mafia-table-mobile-v2.webp",
  "/black-midnight-cinematic-wide-v1.png",
  "/black-midnight-cinematic-mobile-v1.png",
  "/evidence-token-atlas.webp",
  "/case-room-wide.webp",
  "/case-room-mobile.webp",
  "/midnight-city-ui.webp",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || event.request.url.includes("/api/")) return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
