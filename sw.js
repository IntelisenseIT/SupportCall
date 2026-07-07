const CACHE = "supportcall-v3";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api")) return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match("./index.html")))
  );
});

/*
 Web Push handler. Not active in the demo build — it requires a push backend
 (VAPID keys + a server posting to the browser push service). When that backend
 exists, pushes arriving while the app is closed will surface through here.
 On iOS this only works after the app is added to the home screen (iOS 16.4+),
 and there is no Critical Alert / mute override on the web — which is why the
 design treats native push as the primary channel and PWA as secondary.
*/
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  const title = data.title || "URGENT — support incident";
  const body = data.body || "An incident requires your response.";
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: data.tag || "supportcall-incident",
      renotify: true,
      requireInteraction: true,
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      vibrate: [200, 100, 200, 100, 400],
      data: { url: data.url || "./index.html" }
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) return c.focus();
      }
      return self.clients.openWindow(e.notification.data?.url || "./index.html");
    })
  );
});
