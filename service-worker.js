/*
 * service-worker.js — offline shell cache for the Sheets-backed "22" PWA (v3).
 *
 * The data lives in a Google Sheet, reached through an Apps Script web app
 * (sheet-store.js talks to script.google.com / script.googleusercontent.com
 * directly). This SW only caches the static shell for offline use and lets the
 * Sheet API calls pass straight through to the network (cache-busted by the app).
 *
 * Reminders are delivered by native iOS Shortcuts (alarm-grade), so this SW
 * does NOT need push to fulfil the reminder requirement. A push handler is
 * kept as an optional future hook but no backend sends to it in v1.
 */
'use strict';

const CACHE = 'aligners-sheets-v1';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './wear-core.js', './sheet-store.js',
  './manifest.json', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never touch the Sheet API — always straight to network (app cache-busts).
  if (url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com') return;
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // NETWORK-FIRST for our own shell so a new deploy takes effect immediately
  // (a cache-first SW would pin users to stale HTML/CSS/JS after an update).
  // Falls back to cache only when offline — preserving installable/offline use.
  e.respondWith(
    fetch(e.request).then(resp => {
      if (resp && resp.ok) {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return resp;
    }).catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
  );
});

// Optional future push hook (no backend sends in v1).
self.addEventListener('push', (e) => {
  let data = { title: 'Aligners', body: 'Time to put your aligners back in.' };
  try { if (e.data) data = Object.assign(data, e.data.json()); } catch (_) {}
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body, icon: './icons/icon-192.png', badge: './icons/icon-192.png',
    tag: 'aligners-reinsert', renotify: true,
  }));
});
