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
const encoded = (value) => Buffer.from(value).toString("base64url");
const categories = ["transform", "livetree", "livemap", "locus", "livehost", "reflect", "unit", "browser", "certification"];

test("static assembly promotes only public index and indexed row artifacts", async () => {
  const work = await mkdtemp(join(tmpdir(), "hson-static-assembly-"));
  const accepted = join(work, "accepted.json");
  const source = join(work, "site", publicRoot);
  const artifact = join(work, "static-production");
  const suiteId = "transform/suite";
  const caseId = `${suiteId}::case`;
  const casePath = `cases/${encoded(caseId)}.json`;
  const caseBytes = Buffer.from(JSON.stringify({ category: "semantic", suiteId, caseId, case: { id: caseId }, evidence: [] }));
  const reportBytes = Buffer.from('{"canonical":true}\n');
  await mkdir(join(source, "cases"), { recursive: true });
  await mkdir(join(source, "suites"), { recursive: true });
  await mkdir(join(source, "categories"), { recursive: true });
  await mkdir(join(source, "reports"), { recursive: true });
  await mkdir(artifact, { recursive: true });
  await writeFile(join(artifact, "index.html"), "<!doctype html>");
  await writeFile(accepted, JSON.stringify({ accepted: true, evidenceRoot: publicRoot }));
  await writeFile(join(source, casePath), caseBytes);
  await writeFile(join(source, "reports", "semantic.json"), reportBytes);
  await writeFile(join(source, "provenance.json"), "{}\n");
  const suitePath = `suites/${encoded(suiteId)}.json`;
  const suiteBytes = Buffer.from(JSON.stringify({ categoryId: "transform", category: "semantic", suiteId, cases: [{ id: caseId, caseId: "case", evidence: { available: true, path: casePath, rawBytes: caseBytes.byteLength, sha256: digest(caseBytes) } }] }));
  await writeFile(join(source, suitePath), suiteBytes);
  const categoryRows = [];
  for (const id of categories) {
    const categoryPath = `categories/${encoded(id)}.json`;
    const categoryBytes = Buffer.from(JSON.stringify({ categoryId: id, suites: id === "transform" ? [{ categoryId: id, category: "semantic", id: suiteId, listing: { available: true, path: suitePath, rawBytes: suiteBytes.byteLength, sha256: digest(suiteBytes) } }] : [] }));
    await writeFile(join(source, categoryPath), categoryBytes);
    categoryRows.push({ id, listing: { available: true, path: categoryPath, rawBytes: categoryBytes.byteLength, sha256: digest(categoryBytes) } });
  }
  await writeFile(join(source, "index.json"), JSON.stringify({
    deployment: { hsonDeployCommit: commit },
    categories: categoryRows,
  }));
  const result = await assemble_static_test_evidence({ artifact, environment: { VITE_TEST_EVIDENCE_ROOT: `/${publicRoot}`, TEST_EVIDENCE_ACCEPTANCE_FILE: accepted } });
  const publicIndex = JSON.parse(await readFile(join(artifact, publicRoot, "index.json"), "utf8"));
  assert.equal(result.fileCount, 12);
  assert.equal(publicIndex.categories.length, 9);
  assert.deepEqual(await readFile(join(artifact, publicRoot, casePath)), caseBytes);
  await assert.rejects(readFile(join(artifact, publicRoot, "reports", "semantic.json")));
  await assert.rejects(readFile(join(artifact, publicRoot, "provenance.json")));
});
