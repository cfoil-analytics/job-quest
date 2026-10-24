// Service worker: saves the app files so it opens with no internet.
// It shows the saved copy right away, then grabs a fresh copy in the background,
// so updates show up the next time you open the app.

const CACHE = 'jobquest-v8';
const STATUS_CACHE = 'jq-status'; // today's progress, written by the app so reminders can mention it
const FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './content/cscs/lessons.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== STATUS_CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const fresh = fetch(req)
        .then(res => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});

// ---------- daily reminder notifications ----------
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Build the message from the progress the app last saved
async function reminderText(fallback) {
  try {
    const res = await (await caches.open(STATUS_CACHE)).match('status');
    if (!res) return fallback;
    const s = await res.json();
    const streak = s.streak > 0 ? `🔥 ${s.streak}-day streak on the line.` : 'Start a new streak today.';
    if (s.date !== todayKey()) return `New day, new quest. ${streak}`;
    if (s.left === 0) return 'All done today 💪 Nice work.';
    return `${s.left} task${s.left === 1 ? '' : 's'} left today. ${streak}`;
  } catch (e) {
    return fallback;
  }
}

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) {}
  event.waitUntil((async () => {
    const body = payload.test ? payload.body : await reminderText(payload.body || 'Your daily quest is waiting.');
    await self.registration.showNotification(payload.title || 'Job Quest', {
      body,
      icon: 'icons/icon-192.png',
      tag: 'daily-reminder',
    });
  })());
});

// Tapping the notification opens the app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      if (list.length) return list[0].focus();
      return self.clients.openWindow('./');
    })
  );
});
