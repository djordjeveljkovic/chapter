import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

// Isolated origin lets the production worker update without mutating the build.
let server: Server;
let origin: string;
let base: string;
let worker: string;
let originalCache: string;
let resources: { url: string; integrity: string }[];
let overrides: Map<string, { body: string; status?: number }>;
const output = resolve(process.env.OFFLINE_AUDIT_DIST || "dist");
const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

test.beforeEach(async () => {
  worker = await readFile(resolve(output, "sw.js"), "utf8");
  base = JSON.parse(worker.match(/const BASE = (.*);/)![1]);
  originalCache = JSON.parse(worker.match(/const CACHE = (.*);/)![1]);
  resources = JSON.parse(worker.match(/const RESOURCES = (.*);/)![1]);
  overrides = new Map();
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url!, "http://localhost").pathname;
    const override = overrides.get(pathname);
    if (override) {
      response.writeHead(override.status || 200, {
        "Content-Type": mime[extname(pathname)] || "text/plain",
        "Cache-Control": "no-store",
      });
      response.end(override.body);
      return;
    }
    try {
      if (pathname === `${base}sw.js`) {
        response.writeHead(200, {
          "Content-Type": "text/javascript",
          "Cache-Control": "no-store",
        });
        response.end(worker);
        return;
      }
      const relative = "/" + pathname.slice(base.length);
      const path = relative.endsWith("/")
        ? `${relative}index.html`
        : relative === "/format"
          ? "/format/index.html"
          : relative;
      const bytes = await readFile(resolve(output, `.${path}`));
      response.writeHead(200, {
        "Content-Type": mime[extname(path)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end("Missing artifact");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No local audit server");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterEach(async () => {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
});

async function openReady(page: Page) {
  await page.goto(`${origin}${base}`);
  await expect(
    page.getByText("Offline app ready", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
}
async function checkOffline(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return await new Promise<boolean>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        channel.port1.close();
        resolve(event.data);
      };
      registration.active!.postMessage({ type: "CHECK_OFFLINE" }, [
        channel.port2,
      ]);
    });
  });
}
async function updateAndWait(page: Page, failed: boolean) {
  return page.evaluate(async (failed) => {
    const registration = await navigator.serviceWorker.ready;
    const completion = new Promise<string>((resolve) => {
      registration.addEventListener(
        "updatefound",
        () => {
          const installing = registration.installing!;
          installing.addEventListener("statechange", () => {
            if (installing.state === (failed ? "redundant" : "installed"))
              resolve(installing.state);
          });
        },
        { once: true },
      );
    });
    await registration.update();
    return await completion;
  }, failed);
}

test("production manifest and all icons reopen with docs while fully offline", async ({
  page,
  context,
}) => {
  await openReady(page);
  const manifest = await page.evaluate(async () =>
    (
      await fetch(
        document.querySelector<HTMLLinkElement>("link[rel=manifest]")!.href,
      )
    ).json(),
  );
  expect(manifest).toMatchObject({
    id: base,
    start_url: `${base}#library`,
    scope: base,
    display: "standalone",
  });
  expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual([
    "192x192",
    "512x512",
  ]);
  for (const icon of manifest.icons) {
    const dimensions = await page.evaluate(
      async (src) =>
        new Promise<number>((resolve) => {
          const image = new Image();
          image.onload = () => resolve(image.naturalWidth);
          image.src = src;
        }),
      icon.src,
    );
    expect(dimensions).toBe(Number(icon.sizes.split("x")[0]));
  }
  const keys = await page.evaluate(() => caches.keys());
  expect(keys).toContain(originalCache);
  const cached = await page.evaluate(
    async (cacheName) =>
      (await (await caches.open(cacheName)).keys()).map(
        (request) => new URL(request.url).pathname,
      ),
    originalCache,
  );
  expect(cached.sort()).toEqual(
    resources.map((resource) => resource.url).sort(),
  );
  await context.setOffline(true);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(`${origin}${base}`);
  await expect(
    reopened.getByText("Offline app ready", { exact: true }),
  ).toBeVisible();
  await reopened.goto(`${origin}${base}format`);
  await expect(
    reopened.getByRole("heading", {
      name: "A simple format. A whole world of ideas.",
    }),
  ).toBeVisible();
  const iconResponses = await reopened.evaluate(
    async (urls: string[]) =>
      Promise.all(urls.map(async (url) => (await fetch(url)).ok)),
    manifest.icons.map((icon: { src: string }) => icon.src),
  );
  expect(iconResponses).toEqual([true, true]);
});

test("offline verification rejects a missing or truncated cached resource", async ({
  page,
}) => {
  await openReady(page);
  expect(await checkOffline(page)).toBe(true);
  const resource = resources.find((resource) => resource.url.endsWith(".js"))!;
  const original = await page.evaluate(
    async ({ cacheName, url }) =>
      (await (await caches.open(cacheName)).match(url))!.text(),
    { cacheName: originalCache, url: resource.url },
  );
  await page.evaluate(
    async ({ cacheName, url }) => {
      await (await caches.open(cacheName)).delete(url);
    },
    { cacheName: originalCache, url: resource.url },
  );
  expect(await checkOffline(page)).toBe(false);
  await page.evaluate(
    async ({ cacheName, url, body }) => {
      await (
        await caches.open(cacheName)
      ).put(url, new Response(body, { status: 200 }));
    },
    {
      cacheName: originalCache,
      url: resource.url,
      body: original.slice(0, 100),
    },
  );
  expect(await checkOffline(page)).toBe(false);
  await page.evaluate(
    async ({ cacheName, url, body }) => {
      await (
        await caches.open(cacheName)
      ).put(url, new Response(body, { status: 200 }));
    },
    { cacheName: originalCache, url: resource.url, body: original },
  );
  expect(await checkOffline(page)).toBe(true);
});

test("failed or truncated update preserves active app and existing caches", async ({
  page,
}) => {
  await openReady(page);
  const resource = resources.find((resource) => resource.url.endsWith(".css"))!;
  for (const [suffix, body, status] of [
    ["failed", "Unavailable", 503],
    ["truncated", "body{}", 200],
  ] as const) {
    overrides.set(resource.url, { body, status });
    worker = worker.replace(
      /const CACHE = .*;/,
      `const CACHE = ${JSON.stringify(`${originalCache}-${suffix}`)};`,
    );
    expect(await updateAndWait(page, true)).toBe("redundant");
    expect(await checkOffline(page)).toBe(true);
    expect(await page.evaluate(() => caches.keys())).toEqual([originalCache]);
    expect(
      await page.evaluate(
        async () => !(await navigator.serviceWorker.ready).waiting,
      ),
    ).toBe(true);
  }
});

test("explicit app update preserves IndexedDB and another deployment cache", async ({
  page,
}) => {
  await openReady(page);
  const foreignCache = "chapter-shell-another-deployment-retain";
  overrides.set("/another-app/sw.js", {
    body: `self.addEventListener('install', event => event.waitUntil(caches.open(${JSON.stringify(foreignCache)}).then(cache => cache.put('/another-app/', new Response('another deployment')))));`,
  });
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/another-app/sw.js", {
      scope: "/another-app/",
    });
  });
  await expect
    .poll(() => page.evaluate(() => caches.keys()))
    .toContain(foreignCache);
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("chapter-library");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("reading", "readwrite");
    transaction
      .objectStore("reading")
      .put(
        {
          bookId: "audit-marker",
          bookmarks: [],
          completed: ["preserve-this-chapter"],
        },
        "audit-marker",
      );
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  worker = worker.replace(
    /const CACHE = .*;/,
    `const CACHE = ${JSON.stringify(`${originalCache}-updated`)};`,
  );
  expect(await updateAndWait(page, false)).toBe("installed");
  await expect(page.getByRole("button", { name: "Reload app" })).toBeVisible();
  expect(await page.evaluate(() => caches.keys())).toContain(originalCache);
  expect(
    await page.evaluate(
      async () => !!(await navigator.serviceWorker.ready).waiting,
    ),
  ).toBe(true);
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Reload app" }).click(),
  ]);
  await expect(
    page.getByText("Offline app ready", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => caches.keys()))
    .toEqual(
      expect.arrayContaining([`${originalCache}-updated`, foreignCache]),
    );
  await expect
    .poll(() => page.evaluate(() => caches.keys()))
    .not.toContain(originalCache);
  const marker = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("chapter-library");
      request.onsuccess = () => resolve(request.result);
    });
    const request = database
      .transaction("reading")
      .objectStore("reading")
      .get("audit-marker");
    const result = await new Promise<{ completed: string[] }>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    database.close();
    return result;
  });
  expect(marker.completed).toEqual(["preserve-this-chapter"]);
  expect(
    await page.evaluate(async () =>
      (await navigator.serviceWorker.getRegistrations()).some(
        (registration) =>
          new URL(registration.scope).pathname === "/another-app/",
      ),
    ),
  ).toBe(true);
});

test("library stays within a 360px viewport with reduced motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openReady(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    360,
  );
  const sampleText = page.locator(".sample-section > div").nth(1);
  expect((await sampleText.boundingBox())!.width).toBeGreaterThan(200);
  const footer = page.locator(".site-footer p");
  expect((await footer.boundingBox())!.width).toBeGreaterThan(180);
  await page.getByRole("button", { name: "Library settings" }).click();
  await page.getByRole("button", { name: "Night", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Paper", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sepia");
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).scrollBehavior,
    ),
  ).toBe("auto");
});

test("360px reader keeps note controls and footer visible with an offline banner", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openReady(page);
  await page.route("https://api.github.com/**", (route) =>
    route.fulfill({ status: 403, json: { message: "Local layout fixture" } }),
  );
  await page.evaluate(async () => {
    const markdown =
      "# Audit chapter\n\n" +
      Array.from(
        { length: 24 },
        () =>
          "A quiet page leaves room for a useful question. The text remains readable while the navigation stays within reach.",
      ).join("\n\n");
    const chapter = {
      id: "audit-chapter",
      path: "book/volumes/01-audit/001-audit.md",
      title: "Audit chapter",
      volume: 1,
      volumeTitle: "Audit",
      number: 1,
      status: "complete",
      markdown,
      plainText: markdown,
      blobSha: "a".repeat(40),
    };
    const book = {
      id: "shell-reader-audit",
      source: { owner: "audit", repo: "fixture", branch: "main", root: "book" },
      title: "Reader layout audit",
      description: "A local runtime fixture",
      commit: "a".repeat(40),
      chapters: [chapter],
      documents: {},
      assets: [],
      issues: [],
      downloadedAt: new Date().toISOString(),
      bytes: markdown.length,
    };
    const database = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("chapter-library");
      request.onsuccess = () => resolve(request.result);
    });
    const transaction = database.transaction("books", "readwrite");
    transaction.objectStore("books").put(book, book.id);
    await new Promise<void>((resolve) => {
      transaction.oncomplete = () => resolve();
    });
    database.close();
    window.location.hash = "read/shell-reader-audit";
  });
  await expect(
    page.getByRole("heading", { name: "Audit chapter", exact: true }),
  ).toBeVisible();
  await context.setOffline(true);
  await expect(
    page.getByText("You're offline. Your saved books are here."),
  ).toBeVisible();
  for (const label of [
    "Add passage note",
    "Reading settings",
    "View passage notes",
    "Next page or chapter",
  ]) {
    const bounds = await page
      .getByRole("button", { name: label, exact: true })
      .boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(780);
  }
  await page
    .getByRole("button", { name: "Add passage note", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Add passage note" }),
  ).toBeVisible();
  const editor = await page
    .getByRole("textbox", { name: "Note text" })
    .boundingBox();
  expect(editor!.width).toBeGreaterThan(280);
  expect(editor!.x + editor!.width).toBeLessThanOrEqual(360);
});
