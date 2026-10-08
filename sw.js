/* SHIFT Driver service worker (v3.8.0)
   - Makes driver.html installable as a PWA.
   - Shows local notifications posted by the page (no server push yet).
   - A `push` handler is included so real Web Push works once VAPID keys + a sender exist. */
const SW_VERSION = "shift-driver-v3.8.0";
self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {}); // network-only; live data must never be stale
self.addEventListener("push", e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || "SHIFT Dispatch", {
    body: data.body || "You have a new stop.",
    icon: "icons/icon-192.png", badge: "icons/icon-192.png",
    tag: data.tag || "shift-stop", renotify: true, data: { url: data.url || "./driver.html" }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./driver.html";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.includes("driver.html")) { c.focus(); return; } }
    return self.clients.openWindow(url);
  }));
});
