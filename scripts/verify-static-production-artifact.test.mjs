import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { verify_static_production_artifact } from "./verify-static-production-artifact.mjs";

const commit = "a".repeat(40);
const evidenceRoot = `/test-evidence/${commit}`;
const categories = ["transform", "livetree", "livemap", "locus", "livehost", "reflect", "unit", "browser", "certification"];
const liveHost = "wss://runtime.example?tenant=public";
async function fixture(panelSource = `const root="${evidenceRoot}";const marker="data-frozen-panel-state frozen-test-panel";const livehost="${liveHost}";const routes="/towl /circuit-verification";`) {
  const work = await mkdtemp(join(tmpdir(), "hson-static-artifact-"));
  const artifact = join(work, "artifact");
  const accepted = join(work, "accepted.json");
  await mkdir(join(work, "site", evidenceRoot.slice(1), "categories"), { recursive: true });
  await mkdir(join(artifact, "assets"), { recursive: true });
  await writeFile(accepted, JSON.stringify({ accepted: true, evidenceRoot: evidenceRoot.slice(1) }));
  await mkdir(join(artifact, evidenceRoot.slice(1), "categories"), { recursive: true });
  const rows = [];
  let rowBytes = 0;
  for (const id of categories) {
    const path = `categories/${Buffer.from(id).toString("base64url")}.json`;
    const bytes = Buffer.from(JSON.stringify({ categoryId: id, suites: [] }));
    rowBytes += bytes.byteLength;
    await writeFile(join(work, "site", evidenceRoot.slice(1), path), bytes);
    await writeFile(join(artifact, evidenceRoot.slice(1), path), bytes);
    rows.push({ id, listing: { available: true, path, rawBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") } });
  }
  const index = JSON.stringify({ deployment: { hsonDeployCommit: commit }, categories: rows });
  await writeFile(join(work, "site", evidenceRoot.slice(1), "index.json"), index);
  await writeFile(join(artifact, evidenceRoot.slice(1), "index.json"), index);
  await writeFile(join(artifact, "index.html"), `<script>const root="${evidenceRoot}"</script>`);
  await writeFile(join(artifact, "assets", "frozen.js"), panelSource);
  return { artifact, environment: { VITE_TEST_EVIDENCE_ROOT: evidenceRoot, TEST_EVIDENCE_ACCEPTANCE_FILE: accepted, VITE_LIVEHOST_WS_URL: liveHost }, rowBytes };
}

test("artifact verifier proves exact root embedding and frozen acquisition isolation", async () => {
  const valid = await fixture();
  assert.deepEqual(verify_static_production_artifact(valid), { evidenceRoot, liveHostOrigin: "wss://runtime.example", frozenPanelSources: 1, rowArtifacts: 9, rowBytes: valid.rowBytes });
  const liveMarker = await fixture(`const marker="frozen-test-panel tests.discover";const livehost="${liveHost}";const routes="/towl /circuit-verification";`);
  assert.throws(() => verify_static_production_artifact(liveMarker), /tests\.discover/);
  const mutable = await fixture(`const marker="frozen-test-panel";const mutable="/test-evidence/latest/index.json";const livehost="${liveHost}";const routes="/towl /circuit-verification";`);
  assert.throws(() => verify_static_production_artifact(mutable), /mutable test-evidence root/);
});

test("artifact verifier requires compiled generic live-client configuration", async () => {
  const missingOrigin = await fixture(`const root="${evidenceRoot}";const marker="frozen-test-panel";const routes="/towl /circuit-verification";`);
  assert.throws(() => verify_static_production_artifact(missingOrigin), /configured VITE_LIVEHOST_WS_URL/);

  const missingRouteBinding = await fixture(`const root="${evidenceRoot}";const marker="frozen-test-panel";const livehost="${liveHost}";`);
  assert.throws(() => verify_static_production_artifact(missingRouteBinding), /expected live application routes/);

  const unconditionalLoopback = await fixture(`const root="${evidenceRoot}";const marker="frozen-test-panel";const livehost="${liveHost}";const routes="/towl /circuit-verification";function towl(){const base="ws://127.0.0.1:8787";const url=new URL(base);url.pathname="/towl";return url}`);
  assert.throws(() => verify_static_production_artifact(unconditionalLoopback), /unconditional TOWL loopback/);

  const obsoleteVariable = await fixture(`const root="${evidenceRoot}";const marker="frozen-test-panel";const livehost="${liveHost}";const routes="/towl /circuit-verification";const obsolete="VITE_HOSTED_TEST_WS_URL";`);
  assert.throws(() => verify_static_production_artifact(obsoleteVariable), /obsolete LiveHost configuration marker/);
});
