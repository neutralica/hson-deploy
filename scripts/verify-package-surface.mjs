import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "../hson-live");
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const required = [".", "./types", "./livetree", "./livemap", "./locus", "./locus/node", "./livehost", "./livehost/node"];

for (const entrypoint of required) {
  const entry = manifest.exports?.[entrypoint];
  if (entry === undefined) throw new Error(`missing hson-live export ${entrypoint}`);
  const paths = typeof entry === "string" ? [entry] : [entry.types, entry.import];
  if (paths.some((path) => typeof path !== "string" || !existsSync(resolve(packageRoot, path)))) {
    throw new Error(`hson-live export ${entrypoint} does not have built type and import artifacts`);
  }
}

console.log(`package surface verification: ${required.join(", ")}`);
