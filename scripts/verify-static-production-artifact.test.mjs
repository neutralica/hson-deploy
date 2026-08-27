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
async function fixture(panelSource = `const root="${evidenceRoot}";const marker="data-frozen-panel-state frozen-test-panel";`) {
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
  return { artifact, environment: { VITE_TEST_EVIDENCE_ROOT: evidenceRoot, TEST_EVIDENCE_ACCEPTANCE_FILE: accepted }, rowBytes };
}

test("artifact verifier proves exact root embedding and frozen acquisition isolation", async () => {
  const valid = await fixture();
  assert.deepEqual(verify_static_production_artifact(valid), { evidenceRoot, frozenPanelSources: 1, rowArtifacts: 9, rowBytes: valid.rowBytes });
  const liveMarker = await fixture(`const marker="frozen-test-panel tests.discover";`);
  assert.throws(() => verify_static_production_artifact(liveMarker), /tests\.discover/);
  const mutable = await fixture(`const marker="frozen-test-panel";const mutable="/test-evidence/latest/index.json";`);
  assert.throws(() => verify_static_production_artifact(mutable), /mutable test-evidence root/);
});
