// ============================================================
// CjayNotes Service Worker
// ============================================================
const CACHE_VERSION = 'cjaynotes-v1.0.0';

const APP_SHELL = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './manifest.json',
    './icon.svg'
];

// ============================================================
// INSTALL
// ============================================================
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_VERSION).then(cache => cache.addAll(APP_SHELL))
    );
});

// ============================================================
// ACTIVATE
// ============================================================
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
        )).then(() => self.clients.claim())
    );
});

// ============================================================
// MESSAGE (skip waiting from update toast)
// ============================================================
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

// ============================================================
// FETCH
// ============================================================
self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Network-only: Google APIs + Cjay Cloud worker
    if (url.hostname.includes('googleapis.com') ||
        url.hostname.includes('accounts.google.com') ||
        url.hostname.includes('cjay-cloud.monaplayzsbackup.workers.dev')) {
        return;
    }

    // Cache-first: fonts
    if (url.hostname.includes('fonts.googleapis.com') ||
        url.hostname.includes('fonts.gstatic.com')) {
        event.respondWith(
            caches.match(req).then(cached => {
                if (cached) return cached;
                return fetch(req).then(res => {
                    const clone = res.clone();
                    caches.open(CACHE_VERSION).then(c => c.put(req, clone));
                    return res;
                }).catch(() => cached);
            })
        );
        return;
    }

    // Stale-while-revalidate: app files
    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.match(req).then(cached => {
                const networkFetch = fetch(req).then(res => {
                    const clone = res.clone();
                    caches.open(CACHE_VERSION).then(c => c.put(req, clone));
                    return res;
                }).catch(() => cached);
                return cached || networkFetch;
            })
        );
    }
});

// ============================================================
// PUSH
// ============================================================
self.addEventListener('push', event => {
    let payload = { title: 'CjayNotes', body: 'You have a new update' };
    try {
        if (event.data) payload = event.data.json();
    } catch (e) {}

    event.waitUntil(
        self.registration.showNotification(payload.title || 'CjayNotes', {
            body: payload.body || '',
            icon: './icon.svg',
            badge: './icon.svg',
            tag: payload.tag || 'cjaynotes',
            data: { url: payload.url || './' }
        })
    );
});

// ============================================================
// NOTIFICATION CLICK
// ============================================================
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const targetUrl = (event.notification.data && event.notification.data.url) || './';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
            for (const c of list) {
                if (c.url.includes('/CjayNotes/') && 'focus' in c) return c.focus();
            }
            if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
        })
    );
});
