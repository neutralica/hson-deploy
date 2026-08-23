import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./preflight-cloudflare.mjs", import.meta.url));

function run_preflight(environment) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: environment,
  });
}

async function fake_wrangler(exitCode) {
  const directory = await mkdtemp(join(tmpdir(), "hson-cloudflare-preflight-"));
  const executable = join(directory, "wrangler");
  await writeFile(executable, `#!/bin/sh\nexit ${exitCode}\n`);
  await chmod(executable, 0o755);
  return directory;
}

test("Cloudflare preflight accepts a token without invoking Wrangler", () => {
  const result = run_preflight({ CLOUDFLARE_API_TOKEN: "test-token", PATH: "/nonexistent" });
  assert.equal(result.status, 0);
  assert.equal(`${result.stdout}${result.stderr}`.includes("test-token"), false);
});

test("Cloudflare preflight accepts an authenticated Wrangler login", async () => {
  const directory = await fake_wrangler(0);
  const result = run_preflight({ PATH: directory });
  assert.equal(result.status, 0);
});

test("Cloudflare preflight rejects absent token and unauthenticated Wrangler", async () => {
  const directory = await fake_wrangler(1);
  const result = run_preflight({ PATH: directory });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLOUDFLARE_API_TOKEN/);
  assert.match(result.stderr, /wrangler login/);
});
