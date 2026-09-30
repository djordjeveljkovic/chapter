import { resolve, join } from "node:path";
import { stat } from "node:fs/promises";

const directory = resolve("dist");
const portArgument = process.argv.indexOf("--port");
const port = Number(
  portArgument >= 0 ? process.argv[portArgument + 1] : process.env.PORT || 4321,
);
const manifest = Bun.file(join(directory, "manifest.webmanifest"));
if (!(await manifest.exists()))
  throw new Error("Build the app first: bun run build");
const base = (await manifest.json()).scope || "/";
const server = Bun.serve({
  hostname: "0.0.0.0",
  port,
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed", { status: 405 });
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("Invalid path", { status: 400 });
    }
    if (base !== "/" && pathname === base.slice(0, -1))
      return Response.redirect(new URL(base, request.url), 308);
    if (!pathname.startsWith(base))
      return new Response("Not found", { status: 404 });
    let path = resolve(directory, pathname.slice(base.length));
    if (path !== directory && !path.startsWith(`${directory}/`))
      return new Response("Not found", { status: 404 });
    try {
      if ((await stat(path)).isDirectory()) path = join(path, "index.html");
    } catch {
      return new Response("Not found", { status: 404 });
    }
    const file = Bun.file(path);
    if (!(await file.exists()))
      return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : file, {
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "Cache-Control": pathname.includes("/_astro/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
});
console.log(`Chapter preview: http://localhost:${server.port}${base}`);
