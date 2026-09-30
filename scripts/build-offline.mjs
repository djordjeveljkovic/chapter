import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";

const dist = resolve(process.env.BUILD_OUTPUT_DIR || "dist");
const rawBase = process.env.SITE_BASE || "/";
const base = `/${rawBase.replace(/^\/+|\/+$/g, "")}${rawBase.replace(/^\/+|\/+$/g, "") ? "/" : ""}`;
const icon = await readFile(join(dist, "icon.svg"));
await Promise.all(
  [192, 512].map((size) =>
    sharp(icon)
      .resize(size, size)
      .png()
      .toFile(join(dist, `icon-${size}.png`)),
  ),
);
await writeFile(
  join(dist, "manifest.webmanifest"),
  JSON.stringify(
    {
      id: base,
      name: "Chapter — Your reading library",
      short_name: "Chapter",
      description:
        "A little space for big ideas. Your GitHub books, ready offline.",
      start_url: `${base}#library`,
      scope: base,
      display: "standalone",
      background_color: "#f8f7f2",
      theme_color: "#364838",
      lang: "en",
      icons: [
        {
          src: `${base}icon-192.png`,
          sizes: "192x192",
          type: "image/png",
          purpose: "any",
        },
        {
          src: `${base}icon-512.png`,
          sizes: "512x512",
          type: "image/png",
          purpose: "any maskable",
        },
      ],
    },
    null,
    2,
  ),
);
async function walk(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? walk(join(directory, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
    ),
  );
  return paths.flat();
}
const files = (await walk(dist)).filter((path) => path !== "sw.js").sort();
const hash = createHash("sha256");
for (const path of files) {
  hash.update(path);
  hash.update(await readFile(join(dist, path)));
}
hash.update(base);
hash.update("offline-worker-v2-integrity-scoped");
const version = hash.digest("hex").slice(0, 16);
const resources = await Promise.all(
  files.map(async (path) => ({
    url: `${base}${path === "index.html" ? "" : path.endsWith("/index.html") ? path.slice(0, -10) : path}`,
    integrity: `sha256-${createHash("sha256")
      .update(await readFile(join(dist, path)))
      .digest("base64")}`,
  })),
);
const scopeKey = createHash("sha256").update(base).digest("hex").slice(0, 10);
const prefix = `chapter-shell-${scopeKey}-`;
const worker = `/* Generated from every production artifact. */
const CACHE = ${JSON.stringify(`${prefix}${version}`)};
const PREFIX = ${JSON.stringify(prefix)};
const BASE = ${JSON.stringify(base)};
const RESOURCES = ${JSON.stringify(resources)};
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
`;
await writeFile(join(dist, "sw.js"), worker);
console.log(
  `Offline shell ${version}: ${resources.length} files precached at ${base}`,
);
