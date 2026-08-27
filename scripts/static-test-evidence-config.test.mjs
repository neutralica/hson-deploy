import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { validate_accepted_static_test_evidence, validate_static_test_evidence_root } from "./static-test-evidence-config.mjs";

const commit = "a".repeat(40);
const categories = ["transform", "livetree", "livemap", "locus", "livehost", "reflect", "unit", "browser", "certification"];

async function accepted_fixture() {
  const root = await mkdtemp(join(tmpdir(), "hson-static-evidence-"));
  const acceptancePath = join(root, "accepted.json");
  const evidenceRoot = `test-evidence/${commit}`;
  await mkdir(join(root, "site", evidenceRoot, "categories"), { recursive: true });
  await writeFile(acceptancePath, JSON.stringify({ accepted: true, evidenceRoot, artifactSet: "b".repeat(64) }));
  const rows = [];
  for (const id of categories) {
    const path = `categories/${Buffer.from(id).toString("base64url")}.json`;
    const bytes = Buffer.from(JSON.stringify({ categoryId: id, suites: [] }));
    await writeFile(join(root, "site", evidenceRoot, path), bytes);
    rows.push({ id, listing: { available: true, path, rawBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") } });
  }
  await writeFile(join(root, "site", evidenceRoot, "index.json"), JSON.stringify({ deployment: { hsonDeployCommit: commit }, categories: rows }));
  return { acceptancePath, root: `/${evidenceRoot}` };
}

test("static evidence root accepts only an exact immutable deployment commit", () => {
  assert.deepEqual(validate_static_test_evidence_root(`/test-evidence/${commit}`), { root: `/test-evidence/${commit}`, deploymentCommit: commit });
  for (const invalid of [undefined, "", `test-evidence/${commit}`, "/test-evidence/latest", `/test-evidence/../${commit}`, `/test-evidence/${commit}?x=1`, `/test-evidence/${commit}#x`, "/test-evidence/abc"]) {
    assert.throws(() => validate_static_test_evidence_root(invalid));
  }
});

test("static preflight root is bound to accepted Phase 3 evidence and its index commit", async () => {
  const fixture = await accepted_fixture();
  const valid = validate_accepted_static_test_evidence({ VITE_TEST_EVIDENCE_ROOT: fixture.root, TEST_EVIDENCE_ACCEPTANCE_FILE: fixture.acceptancePath });
  assert.equal(valid.deploymentCommit, commit);
  assert.throws(() => validate_accepted_static_test_evidence({ VITE_TEST_EVIDENCE_ROOT: `/test-evidence/${"c".repeat(40)}`, TEST_EVIDENCE_ACCEPTANCE_FILE: fixture.acceptancePath }), /does not match accepted evidence root/);
  assert.throws(() => validate_accepted_static_test_evidence({ VITE_TEST_EVIDENCE_ROOT: fixture.root }), /TEST_EVIDENCE_ACCEPTANCE_FILE/);
});
