import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createHash } from "node:crypto";
import { EXPECTED_CERTIFICATION_AUTHORITY, inspect_reusable_certified_artifact } from "./static-deployment-authority.mjs";

const commit = "a".repeat(40);
const artifactSet = "b".repeat(64);
const evidenceRoot = `test-evidence/${commit}`;
const environment = { VITE_LIVEHOST_WS_URL: "wss://runtime.example" };
const categories = ["transform", "livetree", "livemap", "locus", "livehost", "reflect", "unit", "browser", "certification"];

async function fixture(receiptOverrides = {}, liveHost = "wss://runtime.example") {
  const deploymentRoot = await mkdtemp(join(tmpdir(), "hson-deploy-authority-"));
  const artifact = join(deploymentRoot, "static-production");
  const materialization = join(deploymentRoot, ".deployment-work", "materialize-fixture");
  const publicEvidence = join(artifact, evidenceRoot);
  const acceptedEvidence = join(materialization, "site", evidenceRoot);
  await mkdir(join(artifact, "assets"), { recursive: true });
  await mkdir(join(publicEvidence, "categories"), { recursive: true });
  await mkdir(join(acceptedEvidence, "categories"), { recursive: true });
  const rows = [];
  for (const id of categories) {
    const path = `categories/${Buffer.from(id).toString("base64url")}.json`;
    const bytes = Buffer.from(JSON.stringify({ categoryId: id, suites: [] }));
    await writeFile(join(publicEvidence, path), bytes);
    await writeFile(join(acceptedEvidence, path), bytes);
    rows.push({ id, listing: { available: true, path, rawBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") } });
  }
  const index = JSON.stringify({ deployment: { hsonDeployCommit: commit }, categories: rows });
  await writeFile(join(materialization, "accepted.json"), JSON.stringify({ accepted: true, evidenceRoot, artifactSet }));
  await writeFile(join(publicEvidence, "index.json"), index);
  await writeFile(join(acceptedEvidence, "index.json"), index);
  await writeFile(join(artifact, "index.html"), `<script>const root="/${evidenceRoot}"</script>`);
  await writeFile(join(artifact, "assets", "frozen.js"), `const env={VITE_LIVEHOST_WS_URL:${JSON.stringify(liveHost)}};const marker='data-frozen-panel-state frozen-test-panel';const routes='/towl /circuit-verification';`);
  await writeFile(join(artifact, "certification-receipt.json"), JSON.stringify({
    schemaVersion: 1,
    kind: "hson-tests-explorer-certification",
    certified: true,
    authority: EXPECTED_CERTIFICATION_AUTHORITY,
    evidenceRoot: `/${evidenceRoot}`,
    deploymentCommit: commit,
    evidenceArtifactSetSha256: artifactSet,
    ...receiptOverrides,
  }));
  return { deploymentRoot, artifact };
}

test("certified artifact validity uses the embedded LiveHost identity while freshness reports current source identity", async () => {
  const valid = await fixture();
  const reusable = inspect_reusable_certified_artifact({ ...valid, environment: {}, currentCommit: () => commit });
  assert.equal(reusable.valid, true, reusable.reason);
  assert.equal(reusable.freshness, "current");
  assert.equal(reusable.authority.artifactSetSha256, artifactSet);
  assert.equal(reusable.authority.liveHost.origin, "wss://runtime.example");
  assert.equal(reusable.publication.suitable, true);

  const unrelatedDeployInput = inspect_reusable_certified_artifact({
    ...valid,
    environment: { VITE_LIVEHOST_WS_URL: "wss://different.example" },
    currentCommit: () => commit,
  });
  assert.equal(unrelatedDeployInput.valid, true, unrelatedDeployInput.reason);
  assert.equal(unrelatedDeployInput.authority.liveHost.origin, "wss://runtime.example");

  const stale = inspect_reusable_certified_artifact({ ...valid, environment, currentCommit: () => "c".repeat(40) });
  assert.equal(stale.valid, true);
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.certifiedDeploymentCommit, commit);
  assert.equal(stale.currentDeploymentCommit, "c".repeat(40));

  const staleAuthority = await fixture({ authority: "npm -w hson-demo2 run test:inclusive-library-node" });
  const rejectedAuthority = inspect_reusable_certified_artifact({ ...staleAuthority, environment, currentCommit: () => commit });
  assert.equal(rejectedAuthority.valid, false);
  assert.match(rejectedAuthority.reason, /stale or unknown authority/);

  const mismatched = await fixture({ evidenceArtifactSetSha256: "d".repeat(64) });
  const rejectedHash = inspect_reusable_certified_artifact({ ...mismatched, environment, currentCommit: () => commit });
  assert.equal(rejectedHash.valid, false);
  assert.match(rejectedHash.reason, /certified evidence hash/);
});

test("a current loopback-certified artifact remains valid but is separately not publication-suitable", async () => {
  const valid = await fixture({}, "ws://127.0.0.1:8787");
  const reusable = inspect_reusable_certified_artifact({ ...valid, environment: {}, currentCommit: () => commit });
  assert.equal(reusable.valid, true, reusable.reason);
  assert.equal(reusable.freshness, "current");
  assert.equal(reusable.authority.artifactSetSha256, artifactSet);
  assert.equal(reusable.authority.evidenceRoot, `/test-evidence/${commit}`);
  assert.equal(reusable.publication.suitable, false);
  assert.match(reusable.publication.reason, /valid but uses local runtime origin ws:\/\/127\.0\.0\.1:8787/);
});

test("corrupted static bytes remain invalid regardless of source freshness", async () => {
  const value = await fixture();
  await writeFile(join(value.artifact, "index.html"), "<html>missing immutable evidence root</html>");
  const result = inspect_reusable_certified_artifact({ ...value, environment, currentCommit: () => "c".repeat(40) });
  assert.equal(result.valid, false);
  assert.match(result.reason, /does not match any accepted materialization/);
});
