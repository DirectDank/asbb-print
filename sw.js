// ASBB Print service worker: offline use and receiving files from the Android share menu.
const VERSION = 'asbb-print-v1.2.2';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/store.js', 'js/image.js', 'js/printer.js', 'js/designer.js', 'js/lzo.js',
  'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs', 'vendor/qrcode.js', 'vendor/JsBarcode.all.min.js',
  'img/asbb-logo.svg', 'img/asbb-logo-mono.png', 'img/icon-192.png', 'img/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('asbb-print-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Share target: a PDF or picture shared from another app arrives as a POST.
  if (e.request.method === 'POST' && url.pathname.endsWith('/share')) {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const file = form.get('file');
        if (file && typeof file !== 'string') {
          const cache = await caches.open('asbb-share');
          await cache.put('shared-file', new Response(file, { headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name || 'shared') } }));
        }
      } catch { /* fall through */ }
      return Response.redirect('./?share=1', 303);
    })());
    return;
  }

  if (e.request.method !== 'GET') return;

  // Google Fonts: cache for offline.
  if (url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    e.respondWith(caches.open(VERSION + '-fonts').then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      c.put(e.request, res.clone());
      return res;
    }).catch(() => fetch(e.request)));
    return;
  }

  if (url.origin !== location.origin) return;

  // App files: serve from cache straight away, refresh in the background.
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: e.request.mode === 'navigate' });
    const net = fetch(e.request).then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || c.match('index.html');
  }));
});
