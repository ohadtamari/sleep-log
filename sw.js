// Keeps the app working offline. Bump CACHE whenever a file changes.
const CACHE = 'sleep-log-v3';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'logic.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const REMINDERS = {
  morning: 'בוקר טוב. איך ישנת? זה הזמן למלא את היומן.',
  evening: 'ערב טוב. זה הזמן למלא את היומן של היום.',
};

const readPart = (event) => {
  try {
    const part = event.data && event.data.json().part;
    if (REMINDERS[part]) return part;
  } catch { /* an empty or unreadable message still shows a reminder */ }
  const hour = new Date().getHours();
  return hour >= 4 && hour < 15 ? 'morning' : 'evening';
};

self.addEventListener('push', (event) => {
  const part = readPart(event);
  event.waitUntil(self.registration.showNotification('יומן שינה', {
    body: REMINDERS[part],
    icon: 'icons/icon-192.png',
    lang: 'he',
    dir: 'rtl',
    tag: 'reminder',
    data: { part },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const part = event.notification.data && event.notification.data.part;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      if (windows.length) {
        windows[0].postMessage({ openPart: part });
        return windows[0].focus();
      }
      return self.clients.openWindow(new URL(`index.html?part=${part}`, self.registration.scope).href);
    })
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(event.request).catch(() => {
        if (event.request.mode === 'navigate') return caches.match('index.html');
        return Response.error();
      });
    })
  );
});
