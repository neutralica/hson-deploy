import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "hson-demo2", "dist");
const endpoint = process.env.VITE_HOSTED_TEST_WS_URL?.trim();

if (endpoint === undefined || endpoint === "") {
  throw new Error("VITE_HOSTED_TEST_WS_URL is required to verify the static production artifact.");
}
if (!existsSync(resolve(dist, "index.html"))) throw new Error("Static production artifact is missing dist/index.html.");

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

const sources = files(dist)
  .filter((path) => /\.(?:html|js|css)$/.test(path))
  .map((path) => readFileSync(path, "utf8"));
if (!sources.some((source) => source.includes(endpoint))) {
  throw new Error("Static production artifact does not contain the configured VITE_HOSTED_TEST_WS_URL.");
}

console.log("Static production artifact: configured Node WebSocket endpoint is embedded.");
