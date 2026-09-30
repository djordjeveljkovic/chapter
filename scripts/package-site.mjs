import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";

const directory = resolve("dist");
const output = resolve("release");
const files = {};
async function collect(relative = "") {
  for (const entry of await readdir(join(directory, relative), {
    withFileTypes: true,
  })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile())
      files[path] = await readFile(join(directory, path));
    else throw new Error(`Cannot package a non-file build artifact: ${path}`);
  }
}
await collect();
if (!files["index.html"] || !files["sw.js"] || !files["manifest.webmanifest"])
  throw new Error("The production app is incomplete. Run bun run package.");
const worker = files["sw.js"].toString("utf8");
const base = JSON.parse(worker.match(/^const BASE = (.+);$/m)?.[1] || "null");
const resources = JSON.parse(
  worker.match(/^const RESOURCES = (.+);$/m)?.[1] || "null",
);
if (typeof base !== "string" || !Array.isArray(resources))
  throw new Error("The offline worker has no valid build inventory.");
const verified = new Set();
for (const resource of resources) {
  if (!resource.url.startsWith(base))
    throw new Error(`Resource outside the app scope: ${resource.url}`);
  const relative = resource.url.slice(base.length);
  const path =
    relative.endsWith("/") || !relative ? `${relative}index.html` : relative;
  const contents = files[path];
  if (
    !contents ||
    resource.integrity !==
      `sha256-${createHash("sha256").update(contents).digest("base64")}`
  )
    throw new Error(`Missing or changed offline artifact: ${path}`);
  verified.add(path);
}
if (Object.keys(files).some((path) => path !== "sw.js" && !verified.has(path)))
  throw new Error(
    "A production artifact is missing from the offline inventory.",
  );
await mkdir(output, { recursive: true });
const archive = zipSync(files, { level: 6 });
const archivePath = join(output, "chapter-site.zip");
await writeFile(archivePath, archive);
const checksum = createHash("sha256").update(archive).digest("hex");
await writeFile(
  join(output, "chapter-site.sha256"),
  `${checksum}  chapter-site.zip\n`,
);
await writeFile(
  join(output, "deployment.json"),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      scope: base,
      archive: "chapter-site.zip",
      sha256: checksum,
      files: Object.keys(files).sort(),
      offlineArtifactsVerified: verified.size,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Packaged ${Object.keys(files).length} files for HTTPS deployment at ${base}: ${archivePath}`,
);
