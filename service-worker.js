const CACHE = 'mrz-pwa-pro-upload-v1';
const ASSETS = ['./','./index.html','./mrz-pro-upload.js','./sw-register.js','./manifest.json','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys=>Promise.all(keys.map(k=>k!==CACHE && caches.delete(k))))); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (ASSETS.includes(url.pathname) || ASSETS.includes('.'+url.pathname)) {
    e.respondWith(caches.match(e.request).then(r=>r || fetch(e.request)));
  }
});
