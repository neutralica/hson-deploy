import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decode_artifact_id, encode_artifact_id, materialize_test_evidence, validate_capture, verify_materialized_evidence } from "./materializer.mjs";
import { make_capture } from "./test-fixture.mjs";

async function temporary() { return mkdtemp(join(tmpdir(), "hson-evidence-")); }

test("successful source capture validation proves terminal accounting and cleanup", async () => {
  const fixture = await make_capture(await temporary());
  const source = await validate_capture(fixture.candidate, { verifyRevisions: false });
  assert.deepEqual(source.accounting.certifications, { total: 3, pass: 3 });
  assert.equal(source.accounting.inspectionReruns, 0);
});

test("combined capture cleanup validates both normal and certification executions", async () => {
  const fixture = await make_capture(await temporary());
  const cleanupPath = join(fixture.capture, "capture-cleanup.json");
  const snapshot = JSON.parse(await readFile(cleanupPath, "utf8"));
  await writeFile(cleanupPath, `${JSON.stringify({ captures: { normal: snapshot, certification: snapshot } }, null, 2)}\n`);
  await validate_capture(fixture.candidate, { verifyRevisions: false });

  const failed = structuredClone(snapshot);
  failed.browser.activeProcesses = 1;
  await writeFile(cleanupPath, `${JSON.stringify({ captures: { normal: snapshot, certification: failed } }, null, 2)}\n`);
  await assert.rejects(validate_capture(fixture.candidate, { verifyRevisions: false }), /BROWSER_PROCESSES_REMAIN:certification/);
});

test("certification accounting derives from the exact selected result set", async () => {
  const fixture = await make_capture(await temporary(), { certificationCount: 4 });
  const source = await validate_capture(fixture.candidate, { verifyRevisions: false });
  assert.deepEqual(source.accounting.certifications, { total: 4, pass: 4 });

  const reportPath = join(fixture.capture, "certification.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  report.suiteRuns[3].id = "cert/unexpected";
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const metadataPath = join(fixture.capture, "capture-metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.runs.certification.rawBytes = (await stat(reportPath)).size;
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await assert.rejects(validate_capture(fixture.candidate, { verifyRevisions: false }), /TEST_SELECTION_RESULT_SET_MISMATCH:certification/);
});

test("failed and incomplete captures reject before evidence is read", async () => {
  const fixture = await make_capture(await temporary());
  await writeFile(join(fixture.capture, "browser.json"), "{broken");
  await assert.rejects(validate_capture(fixture.candidate, { verifyRevisions: false }), /CAPTURE_JSON_INVALID:browser.json/);
  const incomplete = await make_capture(await temporary());
  const metadata = JSON.parse(await readFile(join(incomplete.capture, "capture-metadata.json"), "utf8"));
  metadata.selectedStages = ["semantic"];
  await writeFile(join(incomplete.capture, "capture-metadata.json"), JSON.stringify(metadata));
  await assert.rejects(validate_capture(incomplete.candidate, { verifyRevisions: false }), /CAPTURE_NOT_NORMAL_OR_LEGACY_COMBINED/);
});

test("normal semantic and browser capture materializes without executing certification aggregates", async () => {
  const root = await temporary();
  const fixture = await make_capture(root);
  const metadata = JSON.parse(await readFile(join(fixture.capture, "capture-metadata.json"), "utf8"));
  metadata.selectedStages = ["semantic", "browser"];
  delete metadata.runs.certification;
  await writeFile(join(fixture.capture, "capture-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  await rm(join(fixture.capture, "certification.json"));
  const result = await materialize_test_evidence(fixture.candidate, { workRoot: join(root, "work"), verifyRevisions: false, materializedAt: "fixed" });
  assert.equal(result.index.categories.find((category: any) => category.id === "certification").status, "unexecuted");
  assert.deepEqual(Object.keys(result.provenance.runs), ["semantic", "browser"]);
  assert.equal(result.index.overall.suites, 3);
  assert.deepEqual(result.index.categories.map((category: any) => category.id), ["transform", "livetree", "livemap", "locus", "livehost", "reflect", "unit", "browser", "certification"]);
});

test("path encoding is reversible, filesystem-safe, and collision-free", () => {
  const ids = ["suite/case::one", "suite case/☃", "suite_case-one"];
  const encoded = ids.map(encode_artifact_id);
  assert.equal(new Set(encoded).size, ids.length);
  assert.equal(encoded.every((value) => /^[A-Za-z0-9_-]+$/.test(value)), true);
  assert.deepEqual(encoded.map(decode_artifact_id), ids);
});

test("index and lazy artifacts exactly partition retained case and suite evidence", async () => {
  const root = await temporary();
  const fixture = await make_capture(root);
  const result = await materialize_test_evidence(fixture.candidate, { workRoot: join(root, "work"), verifyRevisions: false, materializedAt: "fixed" });
  assert.equal(result.verification.caseCount, 2);
  assert.equal(result.verification.caseArtifactCount, 2);
  assert.equal(result.verification.suiteArtifactCount, 6);
  assert.equal(result.verification.categoryArtifactCount, 9);
  assert.equal(result.verification.evidenceEntryCount, 5);
  assert.equal(result.index.overall.suites, 6);
  assert.equal(JSON.stringify(result.index).includes("transformerArtifact"), false);
  assert.equal(JSON.stringify(result.index).includes("browser attachment"), false);
  const category = JSON.parse(await readFile(join(result.evidenceRoot, result.index.categories.find((entry: any) => entry.id === "transform").listing.path), "utf8"));
  const semantic = category.suites.find((entry: any) => entry.id === "transform/semantic-suite");
  const suite = JSON.parse(await readFile(join(result.evidenceRoot, semantic.listing.path), "utf8"));
  assert.equal(suite.cases[0].evidence.rawBytes, (await stat(join(result.evidenceRoot, suite.cases[0].evidence.path))).size);
});

test("canonical report bytes, report hashes, provenance, and artifact-set digest independently verify", async () => {
  const root = await temporary();
  const fixture = await make_capture(root);
  const source = await validate_capture(fixture.candidate, { verifyRevisions: false });
  const result = await materialize_test_evidence(fixture.candidate, { workRoot: join(root, "work"), verifyRevisions: false, materializedAt: "fixed" });
  assert.deepEqual(await readFile(join(result.evidenceRoot, "reports/semantic.json")), await readFile(join(fixture.capture, "semantic.json")));
  assert.deepEqual(result.provenance.deployment, fixture.metadata.deployment);
  assert.equal(result.provenance.runs.semantic.reportBytes, (await stat(join(fixture.capture, "semantic.json"))).size);
  await verify_materialized_evidence(source, result.evidenceRoot);
  const category = JSON.parse(await readFile(join(result.evidenceRoot, result.index.categories.find((entry: any) => entry.id === "transform").listing.path), "utf8"));
  const suite = JSON.parse(await readFile(join(result.evidenceRoot, category.suites[0].listing.path), "utf8"));
  const casePath = suite.cases[0].evidence.path;
  await writeFile(join(result.evidenceRoot, casePath), "{}\n");
  await assert.rejects(verify_materialized_evidence(source, result.evidenceRoot), /CASE_SIZE_MISMATCH|CASE_MUTATED/);
});

test("repeat materialization is byte-deterministic when materializedAt is fixed", async () => {
  const root = await temporary();
  const fixture = await make_capture(root);
  const first = await materialize_test_evidence(fixture.candidate, { workRoot: join(root, "work-a"), verifyRevisions: false, materializedAt: "fixed" });
  const second = await materialize_test_evidence(fixture.candidate, { workRoot: join(root, "work-b"), verifyRevisions: false, materializedAt: "fixed" });
  assert.equal(first.provenance.artifactSet.sha256, second.provenance.artifactSet.sha256);
  assert.deepEqual(await readFile(join(first.evidenceRoot, "index.json")), await readFile(join(second.evidenceRoot, "index.json")));
  assert.deepEqual(await readFile(join(first.evidenceRoot, "provenance.json")), await readFile(join(second.evidenceRoot, "provenance.json")));
});

test("invalid source identity rejects before a materialization candidate is created", async () => {
  const root = await temporary();
  const fixture = await make_capture(root, { longCaseId: true });
  const work = join(root, "deployment-owned-work");
  await assert.rejects(materialize_test_evidence(fixture.candidate, { workRoot: work, verifyRevisions: false }), /CASE_OWNER_MISMATCH/);
  await assert.rejects(readdir(work));
});
