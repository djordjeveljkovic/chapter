/* Generated from every production artifact. */
const CACHE = "chapter-shell-ee8d1d99b1-4124b036315abaa7";
const PREFIX = "chapter-shell-ee8d1d99b1-";
const BASE = "/chapter/";
const RESOURCES = [{"url":"/chapter/_astro/App.BwFHtJdZ.js","integrity":"sha256-ksrZWLzxaMbq2rkv9BYBrSCx4wMnKYef5A5mAYfXgIg="},{"url":"/chapter/_astro/Layout.B2ZT_45t.css","integrity":"sha256-YvwhBmA3/Cs6IEnqLY4z6iICha1S85rKzPEXTkJSdvE="},{"url":"/chapter/_astro/client.CXM7gXZ1.js","integrity":"sha256-Omjax0u3AXb8d+5qOrmIUM2D6qlH0rvxuDpTjJTGePQ="},{"url":"/chapter/_astro/react.yIOJJ3r4.js","integrity":"sha256-IEGoIBnIKjaXPJNZ6gaMXXkRaEEqcnMozJxLP/8c1MY="},{"url":"/chapter/format/","integrity":"sha256-Sr/NS9Wmhu1IjjqZVS7N1wYaHym18xMAyLy2lrBeIyU="},{"url":"/chapter/icon-192.png","integrity":"sha256-fdIsSBTUUZYUzGXnwQDtA76mIAkgjknSgtrOo+2otSU="},{"url":"/chapter/icon-512.png","integrity":"sha256-yXGlSWsLW+8+uQmiOyLcytmv3JGw8bPHSyJmeG1j1WE="},{"url":"/chapter/icon.svg","integrity":"sha256-8jtSfzYPWDXWRHoGtqd4Qz0q6M5eSFm5D/UyLTBWLl4="},{"url":"/chapter/","integrity":"sha256-fqv5Wdps5NnZ4aKHiSc+7SQqYjJCB9qCYyD48zhFgdA="},{"url":"/chapter/manifest.webmanifest","integrity":"sha256-Gc6rGNipVXv/0CtXkORZHwWEywHvTPXrNvmduKTFLHQ="}];
const FILES = RESOURCES.map(resource => resource.url);
const SHELL = BASE;
async function complete(cache) {
  const results = await Promise.all(RESOURCES.map(async resource => {
    const response = await cache.match(resource.url);
    if (!response?.ok) return false;
    const bytes = await response.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const encoded = btoa(String.fromCharCode(...new Uint8Array(digest)));
    return resource.integrity === 'sha256-' + encoded;
  }));
  return results.every(Boolean);
}
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const existed = await caches.has(CACHE);
    const cache = await caches.open(CACHE);
    try {
      await cache.addAll(RESOURCES.map(resource => new Request(resource.url, { cache: 'reload', integrity: resource.integrity })));
      if (!await complete(cache)) throw new Error('Incomplete offline app');
    } catch (error) {
      if (!existed) await caches.delete(CACHE);
      throw error;
    }
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    if (!await complete(cache)) return;
    await self.clients.claim();
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)));
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil((async () => {
      if (await complete(await caches.open(CACHE))) await self.skipWaiting();
    })());
  } else if (event.data?.type === 'CHECK_OFFLINE') {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(CACHE);
        event.ports[0]?.postMessage(await complete(cache));
      } catch { event.ports[0]?.postMessage(false); }
    })());
  }
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const pathname = url.pathname.endsWith('/index.html') ? url.pathname.slice(0, -10) : url.pathname;
    const canonical = pathname === BASE.slice(0, -1) ? BASE : FILES.includes(pathname + '/') ? pathname + '/' : pathname;
    const cached = await cache.match(canonical);
    if (cached) return cached;
    try { return await fetch(request); }
    catch (error) {
      if (request.mode === 'navigate') {
        const shell = await cache.match(SHELL);
        if (shell) return shell;
      }
      throw error;
    }
  })());
});
