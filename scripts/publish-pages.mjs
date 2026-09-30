import { cp, readdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const project = resolve(".");
const dist = join(project, "dist");
const manifest = JSON.parse(await Bun.file(join(dist, "manifest.webmanifest")).text());
if (manifest.scope !== "/chapter/") {
  throw new Error("Build GitHub Pages with SITE_BASE=/chapter/ before publishing.");
}

for (const name of ["_astro", "format"]) {
  await rm(join(project, name), { recursive: true, force: true });
}
for (const entry of await readdir(dist)) {
  await cp(join(dist, entry), join(project, entry), { recursive: true });
}
await writeFile(join(project, ".nojekyll"), "");
console.log("Published the /chapter/ build to the repository root.");
