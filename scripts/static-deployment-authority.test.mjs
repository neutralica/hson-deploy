import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { EXPECTED_CERTIFICATION_AUTHORITY, inspect_reusable_certified_artifact } from "./static-deployment-authority.mjs";

const commit = "a".repeat(40);
const artifactSet = "b".repeat(64);
const evidenceRoot = `test-evidence/${commit}`;

async function fixture(receiptOverrides = {}) {
  const deploymentRoot = await mkdtemp(join(tmpdir(), "hson-deploy-authority-"));
  const artifact = join(deploymentRoot, "static-production");
  const materialization = join(deploymentRoot, ".deployment-work", "materialize-fixture");
  const publicEvidence = join(artifact, evidenceRoot);
  const acceptedEvidence = join(materialization, "site", evidenceRoot);
  await mkdir(join(artifact, "assets"), { recursive: true });
  await mkdir(publicEvidence, { recursive: true });
  await mkdir(acceptedEvidence, { recursive: true });
  const index = JSON.stringify({ deployment: { hsonDeployCommit: commit }, suites: [] });
  await writeFile(join(materialization, "accepted.json"), JSON.stringify({ accepted: true, evidenceRoot, artifactSet }));
  await writeFile(join(publicEvidence, "index.json"), index);
  await writeFile(join(acceptedEvidence, "index.json"), index);
  await writeFile(join(artifact, "index.html"), `<script>const root="/${evidenceRoot}"</script>`);
  await writeFile(join(artifact, "assets", "frozen.js"), "const marker='data-frozen-panel-state frozen-test-panel';");
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

test("certified artifact reuse requires current source, evidence identity, and exact byte verification", async () => {
  const valid = await fixture();
  const reusable = inspect_reusable_certified_artifact({ ...valid, currentCommit: () => commit });
  assert.equal(reusable.reusable, true);
  assert.equal(reusable.authority.artifactSetSha256, artifactSet);

  const stale = inspect_reusable_certified_artifact({ ...valid, currentCommit: () => "c".repeat(40) });
  assert.equal(stale.reusable, false);
  assert.match(stale.reason, /source revision/);

  const staleAuthority = await fixture({ authority: "npm -w hson-demo2 run test:inclusive-library-node" });
  const rejectedAuthority = inspect_reusable_certified_artifact({ ...staleAuthority, currentCommit: () => commit });
  assert.equal(rejectedAuthority.reusable, false);
  assert.match(rejectedAuthority.reason, /stale or unknown authority/);

  const mismatched = await fixture({ evidenceArtifactSetSha256: "d".repeat(64) });
  const rejectedHash = inspect_reusable_certified_artifact({ ...mismatched, currentCommit: () => commit });
  assert.equal(rejectedHash.reusable, false);
  assert.match(rejectedHash.reason, /certified evidence hash/);
});

test("verified receipt metadata cannot authorize corrupted static bytes", async () => {
  const value = await fixture();
  await writeFile(join(value.artifact, "index.html"), "<html>missing immutable evidence root</html>");
  const result = inspect_reusable_certified_artifact({ ...value, currentCommit: () => commit });
  assert.equal(result.reusable, false);
  assert.match(result.reason, /does not match any accepted materialization/);
});
