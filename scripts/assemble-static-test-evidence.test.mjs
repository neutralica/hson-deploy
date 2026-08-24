import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assemble_static_test_evidence } from "./assemble-static-test-evidence.mjs";

const commit = "a".repeat(40);
const publicRoot = `test-evidence/${commit}`;
const digest = (value) => createHash("sha256").update(value).digest("hex");

test("static assembly promotes only public index and indexed row artifacts", async () => {
  const work = await mkdtemp(join(tmpdir(), "hson-static-assembly-"));
  const accepted = join(work, "accepted.json");
  const source = join(work, "site", publicRoot);
  const artifact = join(work, "static-production");
  const caseBytes = Buffer.from('{"case":true}\n');
  const reportBytes = Buffer.from('{"canonical":true}\n');
  await mkdir(join(source, "cases"), { recursive: true });
  await mkdir(join(source, "reports"), { recursive: true });
  await mkdir(artifact, { recursive: true });
  await writeFile(join(artifact, "index.html"), "<!doctype html>");
  await writeFile(accepted, JSON.stringify({ accepted: true, evidenceRoot: publicRoot }));
  await writeFile(join(source, "cases", "one.json"), caseBytes);
  await writeFile(join(source, "reports", "semantic.json"), reportBytes);
  await writeFile(join(source, "provenance.json"), "{}\n");
  await writeFile(join(source, "index.json"), JSON.stringify({
    deployment: { hsonDeployCommit: commit },
    categories: [{ id: "semantic", report: { available: true, path: "reports/semantic.json", rawBytes: reportBytes.byteLength, sha256: digest(reportBytes) } }],
    suites: [{ evidence: { available: false }, cases: [{ evidence: { available: true, path: "cases/one.json", rawBytes: caseBytes.byteLength, sha256: digest(caseBytes) } }] }],
  }));
  const result = await assemble_static_test_evidence({ artifact, environment: { VITE_TEST_EVIDENCE_ROOT: `/${publicRoot}`, TEST_EVIDENCE_ACCEPTANCE_FILE: accepted } });
  const publicIndex = JSON.parse(await readFile(join(artifact, publicRoot, "index.json"), "utf8"));
  assert.equal(result.fileCount, 2);
  assert.equal(publicIndex.categories[0].report, undefined);
  assert.deepEqual(await readFile(join(artifact, publicRoot, "cases", "one.json")), caseBytes);
  await assert.rejects(readFile(join(artifact, publicRoot, "reports", "semantic.json")));
  await assert.rejects(readFile(join(artifact, publicRoot, "provenance.json")));
});
