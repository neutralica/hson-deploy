import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("deploy is the direct public alias for static upload", () => {
  const root = resolve(import.meta.dirname, "..");
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.equal(manifest.scripts.deploy, "npm run deploy:static");
  const sources = ["build-static.mjs", "deploy-static.mjs"].map((file) => readFileSync(resolve(import.meta.dirname, file), "utf8")).join("\n");
  assert.doesNotMatch(sources, /playwright|run-canonical-tests|tests\.runSelected|git\s+(?:fetch|pull|checkout|merge|rebase|submodule)/i);
});
