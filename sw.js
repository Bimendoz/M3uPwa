// Service worker: la app abre sin conexión y el directorio de canales queda en caché.
const VERSION = "listas-m3u-v14";
const SHELL = ["./", "index.html", "app.js", "icons.js", "hls.min.js", "manifest.webmanifest", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png"];
const DIR = "https://iptv-org.github.io/api/";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== "directorio").map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = e.request.url;
  if (e.request.method !== "GET") return;
  // directorio: la app maneja su caché (24 h); aquí solo respaldo sin conexión
  if (url.startsWith(DIR)) {
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open("directorio").then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request)));
    return;
  }
  // archivos de la app: primero la red (para recibir actualizaciones), si no hay, la caché
  if (new URL(url).origin === location.origin) {
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then((m) => m || caches.match("index.html"))));
  }
  // videos y demás: directo a la red, sin tocar
});
