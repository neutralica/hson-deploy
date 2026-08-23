import { existsSync, realpathSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = resolve(import.meta.dirname, "../hson-live");
const demoRoot = resolve(import.meta.dirname, "../hson-demo2");

if (!existsSync(resolve(packageRoot, "package.json"))) {
  throw new Error("sibling hson-live checkout is missing.");
}

const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const required = [".", "./types", "./livetree", "./livemap", "./locus", "./locus/node", "./livehost", "./livehost/node"];
const requiredResolution = new Set([".", "./locus", "./locus/node"]);
const demoPackageUrl = pathToFileURL(resolve(demoRoot, "package.json")).href;
const expectedPackageRoot = realpathSync(packageRoot);

for (const entrypoint of required) {
  const entry = manifest.exports?.[entrypoint];
  if (entry === undefined) throw new Error(`missing hson-live export ${entrypoint}`);
  const paths = typeof entry === "string" ? [entry] : [entry.types, entry.import];
  if (paths.some((path) => typeof path !== "string" || !existsSync(resolve(packageRoot, path)))) {
    throw new Error(`hson-live export ${entrypoint} does not have built type and import artifacts`);
  }

  if (requiredResolution.has(entrypoint)) {
    const specifier = entrypoint === "." ? "hson-live" : `hson-live/${entrypoint.slice(2)}`;
    const resolved = realpathSync(new URL(import.meta.resolve(specifier, demoPackageUrl)));
    if (!resolved.startsWith(`${expectedPackageRoot}/`)) {
      throw new Error(`${specifier} resolves outside sibling hson-live checkout: ${resolved}`);
    }
  }
}

console.log("hson-live package exports verified; sibling resolution: hson-live, hson-live/locus, hson-live/locus/node");
