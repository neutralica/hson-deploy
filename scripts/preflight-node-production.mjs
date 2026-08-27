import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const demoRoot = resolve(root, "hson-demo2");
const liveRoot = resolve(root, "hson-live");
const artifacts = [
  resolve(demoRoot, "dist-node/livehost-server.mjs"),
  resolve(demoRoot, "dist-node/circuit-verification-worker.mjs"),
];
const demoPackageUrl = pathToFileURL(resolve(demoRoot, "package.json")).href;

function require_value(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is required for Node production.`);
  return value;
}

for (const artifact of artifacts) {
  if (!existsSync(artifact)) throw new Error(`Node production artifact is missing: ${artifact}`);
}

const expectedLiveRoot = realpathSync(liveRoot);
for (const specifier of ["hson-live", "hson-live/locus", "hson-live/locus/node", "hson-live/livehost/node"]) {
  const resolved = realpathSync(new URL(import.meta.resolve(specifier, demoPackageUrl)));
  if (!resolved.startsWith(`${expectedLiveRoot}/`)) {
    throw new Error(`${specifier} does not resolve from the sibling hson-live checkout.`);
  }
}
for (const specifier of ["ws"]) {
  import.meta.resolve(specifier, demoPackageUrl);
}

const deployment = process.env.LOCUS_DEPLOYMENT ?? "production";
if (deployment !== "production") throw new Error("LOCUS_DEPLOYMENT must be production for Node production preflight.");
if (require_value("LOCUS_ALLOWED_ORIGINS").split(",").every((origin) => origin.trim() === "")) {
  throw new Error("LOCUS_ALLOWED_ORIGINS must contain at least one origin.");
}
if (require_value("LOCUS_BEARER_TOKEN").length < 16) {
  throw new Error("LOCUS_BEARER_TOKEN must contain at least 16 characters.");
}

console.log("Node production preflight: artifacts, sibling runtime resolution, and required production configuration verified.");
