// The panel's service worker: it only shows the alerts the server pushes (see push.js) and opens the panel when one is tapped.
// It has no fetch handler: it never touches the website or the panel's pages, and it keeps nothing.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (event) {
  var d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = {}; }
  event.waitUntil(self.registration.showNotification(String(d.title || 'New order'), {
    body: String(d.body || 'Tap to open your panel.'),
    tag: String(d.tag || 'new-request'),
    renotify: true,
    requireInteraction: true,
    data: { url: '/panel' },
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) { if (list[i].url.indexOf('/panel') >= 0 && 'focus' in list[i]) return list[i].focus(); }
    return self.clients.openWindow('/panel');
  }));
});
