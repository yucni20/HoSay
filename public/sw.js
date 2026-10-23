// Service Worker：離線外殼快取、接收推播、通知按鈕動作
const VERSION = 'v1.0.0';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/badge-72.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // 個人資料不快取，一律走網路
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/index.html')));
    return;
  }
  // 靜態檔：先用快取，同時在背景更新
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(e.request);
    const net = fetch(e.request).then((r) => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => cached);
    return cached || net;
  })());
});

self.addEventListener('push', (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { p = { title: '今天吃了嗎？', body: e.data?.text() }; }
  const opts = {
    body: p.body || '',
    tag: p.tag || 'general',
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    data: p.data || { url: '/' },
    requireInteraction: p.type === 'dose',
  };
  if (p.type === 'dose') {
    opts.actions = [{ action: 'taken', title: '已服用' }, { action: 'snooze', title: '10 分鐘後提醒' }];
  }
  e.waitUntil(self.registration.showNotification(p.title || '今天吃了嗎？', opts));
});

async function openApp(url) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of all) {
    if (new URL(c.url).origin === location.origin) {
      await c.focus();
      c.navigate?.(url).catch(() => {});
      return;
    }
  }
  await self.clients.openWindow(url);
}

self.addEventListener('notificationclick', (e) => {
  const n = e.notification;
  const d = n.data || {};
  n.close();
  e.waitUntil((async () => {
    if ((e.action === 'taken' || e.action === 'snooze') && d.medIds) {
      try {
        const r = await fetch('/api/doses/bulk', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'chile-ma' },
          body: JSON.stringify({ action: e.action, date: d.date, time: d.time, med_ids: d.medIds, minutes: 10 }),
        });
        if (!r.ok) throw new Error(String(r.status));
        const all = await self.clients.matchAll({ type: 'window' });
        all.forEach((c) => c.postMessage({ type: 'doses-updated' }));
        if (e.action === 'taken') {
          await self.registration.showNotification('記好了 🌱', { body: '已幫你記錄為已服用', tag: 'ack', icon: '/icons/icon-192.png', badge: '/icons/badge-72.png', silent: true });
          setTimeout(() => self.registration.getNotifications({ tag: 'ack' }).then((l) => l.forEach((x) => x.close())), 4000);
        }
        return;
      } catch {
        // 未登入或離線：改為開啟 App 讓使用者自行確認
      }
    }
    await openApp(d.url || '/');
  })());
});

// 推播服務更新訂閱時（部分瀏覽器會發生），自動重新登記
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const { publicKey } = await fetch('/api/push/public-key').then((r) => r.json());
    const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - publicKey.length % 4) % 4)), (c) => c.charCodeAt(0));
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await fetch('/api/push/subscribe', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'chile-ma' },
      body: JSON.stringify(sub.toJSON()),
    });
  })());
});
