import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const CATEGORIES = Object.freeze(["semantic", "browser", "certification"] as const);
export const NORMAL_CATEGORIES = Object.freeze(["semantic", "browser"] as const);
export type Category = typeof CATEGORIES[number];
type JsonObject = Record<string, any>;
type ArtifactRecord = Readonly<{ path: string; rawBytes: number; sha256: string }>;

const CAPTURE_CONTROL_FILES = Object.freeze(["capture-metadata.json", "capture-cleanup.json"]);

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function json_bytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function atomic_write(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, path);
}

function git(arguments_: readonly string[], cwd: string): string {
  return execFileSync("git", arguments_, { cwd, encoding: "utf8" }).trim();
}

export function encode_artifact_id(id: string): string {
  assert.equal(typeof id, "string", "TEST_EVIDENCE_ID_NOT_STRING");
  assert.ok(id.length > 0, "TEST_EVIDENCE_ID_EMPTY");
  return Buffer.from(id, "utf8").toString("base64url");
}

export function decode_artifact_id(encoded: string): string {
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  assert.equal(encode_artifact_id(decoded), encoded, "TEST_EVIDENCE_ID_ENCODING_NON_CANONICAL");
  return decoded;
}

function capture_directory(candidate: string): string {
  const absolute = resolve(candidate);
  return basename(absolute) === "capture" ? absolute : join(absolute, "capture");
}

function validate_cleanup(cleanup: JsonObject): void {
  assert.equal(cleanup.clientSockets?.total, 0, "TEST_EVIDENCE_CAPTURE_SOCKETS_REMAIN");
  assert.equal(cleanup.clientSockets?.hostedTests?.total, 0, "TEST_EVIDENCE_CAPTURE_HOSTED_SOCKETS_REMAIN");
  assert.equal(cleanup.clientSockets?.towl, 0, "TEST_EVIDENCE_CAPTURE_TOWL_SOCKETS_REMAIN");
  assert.equal(cleanup.clientSockets?.circuitVerification, 0, "TEST_EVIDENCE_CAPTURE_CIRCUIT_SOCKETS_REMAIN");
  assert.equal(cleanup.browser?.activeProcesses, 0, "TEST_EVIDENCE_CAPTURE_BROWSER_PROCESSES_REMAIN");
  assert.equal(cleanup.browser?.activeJourneys, 0, "TEST_EVIDENCE_CAPTURE_BROWSER_JOURNEYS_REMAIN");
  assert.equal(cleanup.browser?.retainedArtifactRoots, 0, "TEST_EVIDENCE_CAPTURE_BROWSER_ROOTS_REMAIN");
  assert.equal(cleanup.browser?.forcedTerminations, 0, "TEST_EVIDENCE_CAPTURE_FORCED_TERMINATIONS");
}

function assert_unique(values: readonly string[], label: string): void {
  assert.equal(new Set(values).size, values.length, `TEST_EVIDENCE_DUPLICATE_${label}`);
}

function validate_report(category: Category, report: JsonObject, metadata: JsonObject, rawBytes: number): void {
  const run = metadata.runs?.[category];
  assert.ok(run, `TEST_EVIDENCE_CAPTURE_RUN_MISSING:${category}`);
  assert.equal(report.run?.status, "passed", `TEST_EVIDENCE_REPORT_NOT_PASSED:${category}`);
  assert.equal(report.run?.id, run.runId, `TEST_EVIDENCE_RUN_ID_MISMATCH:${category}`);
  assert.equal(run.terminalStatus, "passed", `TEST_EVIDENCE_METADATA_NOT_PASSED:${category}`);
  assert.equal(run.rawBytes, rawBytes, `TEST_EVIDENCE_REPORT_SIZE_MISMATCH:${category}`);
  assert.equal(typeof run.reportHostId, "string", `TEST_EVIDENCE_REPORT_HOST_MISSING:${category}`);
  assert.equal(run.attemptId, `${run.runId}:attempt:1`, `TEST_EVIDENCE_INSPECTION_OR_RETRY_DETECTED:${category}`);
  assert.equal(Number.isInteger(run.reportRev) && run.reportRev >= 0, true, `TEST_EVIDENCE_REPORT_REV_INVALID:${category}`);
  assert.equal(run.reportRev, run.clientAppliedReportRev, `TEST_EVIDENCE_REPORT_REV_UNRECONCILED:${category}`);
  assert.equal(report.error, null, `TEST_EVIDENCE_REPORT_ERROR:${category}`);
  assert.equal(report.summary?.fail, 0, `TEST_EVIDENCE_REPORT_FAILURES:${category}`);
  assert.equal(report.summary?.skip, 0, `TEST_EVIDENCE_REPORT_SKIPS:${category}`);
  assert.equal(report.suiteRuns?.every((suite: JsonObject) => suite.status === "pass"), true, `TEST_EVIDENCE_SUITE_FAILURE:${category}`);
  assert.deepEqual([...report.plan.selectionIds].sort(), [...metadata.selection[category].ids].sort(), `TEST_EVIDENCE_SELECTION_MISMATCH:${category}`);
  assert.equal(run.selectionCount, metadata.selection[category].idCount, `TEST_EVIDENCE_SELECTION_COUNT_MISMATCH:${category}`);
  assert_unique(report.suiteRuns.map((suite: JsonObject) => suite.id), `${category.toUpperCase()}_SUITE`);
  assert_unique(report.suiteRuns.flatMap((suite: JsonObject) => suite.cases.map((item: JsonObject) => item.id)), `${category.toUpperCase()}_CASE`);
  for (const suite of report.suiteRuns) {
    assert.deepEqual(suite.cases.map((item: JsonObject) => item.id), suite.caseOrder, `TEST_EVIDENCE_CASE_ORDER_MISMATCH:${suite.id}`);
    const evidenceIds = suite.evidence.map((entry: JsonObject) => entry.id);
    assert_unique(evidenceIds, `EVIDENCE:${suite.id}`);
    const referenced = [...suite.evidenceRefs, ...suite.cases.flatMap((item: JsonObject) => item.evidenceRefs)];
    assert.equal(referenced.every((id: string) => evidenceIds.includes(id)), true, `TEST_EVIDENCE_REFERENCE_MISSING:${suite.id}`);
    assert.equal(evidenceIds.every((id: string) => referenced.includes(id)), true, `TEST_EVIDENCE_UNOWNED_ENTRY:${suite.id}`);
    const caseOwners = suite.cases.flatMap((item: JsonObject) => item.evidenceRefs);
    assert_unique(caseOwners, `CASE_EVIDENCE_OWNER:${suite.id}`);
  }
}

function validate_accounting(reports: Partial<Record<Category, JsonObject>>, metadata: JsonObject): JsonObject {
  const semantic = reports.semantic;
  assert.ok(semantic, "TEST_EVIDENCE_SEMANTIC_REPORT_MISSING");
  const semanticCases = semantic.suiteRuns.flatMap((suite: JsonObject) => suite.cases);
  assert.equal(semantic.summary.cases, semanticCases.length, "TEST_EVIDENCE_SEMANTIC_CASE_ACCOUNTING");
  assert.equal(semantic.summary.pass, semanticCases.length, "TEST_EVIDENCE_SEMANTIC_PASS_ACCOUNTING");
  assert.equal(semanticCases.every((item: JsonObject) => item.status === "pass" && item.diagnostic !== null), true, "TEST_EVIDENCE_SEMANTIC_DIAGNOSTICS_INCOMPLETE");
  const opaque = semantic.suiteRuns.filter((suite: JsonObject) => suite.executionShape === "opaque-aggregate");
  const opaqueChecks = opaque.reduce((total: number, suite: JsonObject) => total + suite.counts.passed, 0);
  const opaqueDeclared = opaque.reduce((total: number, suite: JsonObject) => total + suite.counts.declared, 0);
  assert.equal(opaqueChecks, opaqueDeclared, "TEST_EVIDENCE_OPAQUE_ACCOUNTING");

  const browser = reports.browser;
  assert.ok(browser, "TEST_EVIDENCE_BROWSER_REPORT_MISSING");
  const browserCases = browser.suiteRuns.flatMap((suite: JsonObject) => suite.cases);
  assert.equal(browserCases.length, browser.summary.cases, "TEST_EVIDENCE_BROWSER_CASE_ACCOUNTING");
  assert.equal(browserCases.every((item: JsonObject) => item.status === "pass"), true, "TEST_EVIDENCE_BROWSER_PASS_ACCOUNTING");
  assert.equal(metadata.runs.browser.journeyCount, browserCases.length, "TEST_EVIDENCE_BROWSER_JOURNEY_ACCOUNTING");

  const certification = reports.certification;
  if (certification !== undefined) {
    assert.equal(certification.suiteRuns.length, 57, "TEST_EVIDENCE_CERTIFICATION_DENOMINATOR");
    assert.equal(metadata.selection.certification.idCount, 57, "TEST_EVIDENCE_CERTIFICATION_SELECTION_DENOMINATOR");
    assert.deepEqual(metadata.selection.certification.h2, { h2b: 10, h2c: 11, h2d: 7, remaining: 0 }, "TEST_EVIDENCE_H2_ACCOUNTING");
    const h2Cleanup = certification.suiteRuns.flatMap((suite: JsonObject) => suite.evidence)
      .filter((entry: JsonObject) => entry.content.includes('"h2Cleanup":"removed"'));
    assert.equal(h2Cleanup.length, 28, "TEST_EVIDENCE_H2_WORKSPACE_CLEANUP_ACCOUNTING");
  }
  const certificationCount = certification === undefined ? 0 : 57;
  return Object.freeze({
    semantic: { canonical: semantic.summary, opaqueChecks: { total: opaqueDeclared, pass: opaqueChecks } },
    browserJourneys: { total: browserCases.length, pass: browserCases.length },
    certifications: { total: certificationCount, pass: certificationCount },
    h2: certification === undefined
      ? { b: 0, c: 0, d: 0, remaining: 0, workspacesRemoved: 0, workspacesRemaining: 0 }
      : { b: 10, c: 11, d: 7, remaining: 0, workspacesRemoved: 28, workspacesRemaining: 0 },
    inspectionReruns: 0,
  });
}

function verify_revisions(root: string, deployment: JsonObject): void {
  assert.equal(git(["rev-parse", "HEAD"], root), deployment.hsonDeployCommit, "TEST_EVIDENCE_DEPLOYMENT_REVISION_MISMATCH");
  for (const [path, field] of [["hson-demo2", "hsonDemo2Gitlink"], ["hson-live", "hsonLiveGitlink"], ["intrastructure", "intrastructureGitlink"]] as const) {
    assert.equal(git(["ls-tree", deployment.hsonDeployCommit, path], root).split(/\s+/)[2], deployment[field], `TEST_EVIDENCE_CAPTURE_GITLINK_MISMATCH:${path}`);
    assert.equal(git(["rev-parse", "HEAD"], join(root, path)), deployment[field], `TEST_EVIDENCE_SUBMODULE_REVISION_MISMATCH:${path}`);
  }
}

export type ValidatedCapture = Readonly<{
  candidate: string;
  capture: string;
  metadata: JsonObject;
  categories: readonly Category[];
  cleanup: JsonObject;
  reports: Partial<Record<Category, JsonObject>>;
  reportBytes: Partial<Record<Category, Buffer>>;
  accounting: JsonObject;
}>;

export async function validate_capture(candidate: string, options: { repositoryRoot?: string; verifyRevisions?: boolean } = {}): Promise<ValidatedCapture> {
  assert.ok(candidate, "TEST_EVIDENCE_CAPTURE_CANDIDATE_REQUIRED");
  const capture = capture_directory(candidate);
  const available = new Set(await readdir(capture));
  for (const file of CAPTURE_CONTROL_FILES) assert.ok(available.has(file), `TEST_EVIDENCE_CAPTURE_FILE_MISSING:${file}`);
  const parsed: Record<string, JsonObject> = {};
  const bytes: Record<string, Buffer> = {};
  for (const file of CAPTURE_CONTROL_FILES) {
    const raw = await readFile(join(capture, file));
    bytes[file] = raw;
    try { parsed[file] = JSON.parse(raw.toString("utf8")); }
    catch { throw new Error(`TEST_EVIDENCE_CAPTURE_JSON_INVALID:${file}`); }
  }
  const metadata = parsed["capture-metadata.json"];
  const normal = JSON.stringify(metadata.selectedStages) === JSON.stringify(NORMAL_CATEGORIES);
  const legacyCertified = JSON.stringify(metadata.selectedStages) === JSON.stringify(CATEGORIES);
  assert.equal(normal || legacyCertified, true, "TEST_EVIDENCE_CAPTURE_NOT_NORMAL_OR_LEGACY_COMBINED");
  const categories = Object.freeze([...(legacyCertified ? CATEGORIES : NORMAL_CATEGORIES)]) as readonly Category[];
  for (const category of categories) {
    const file = `${category}.json`;
    assert.ok(available.has(file), `TEST_EVIDENCE_CAPTURE_FILE_MISSING:${file}`);
    const raw = await readFile(join(capture, file));
    bytes[file] = raw;
    try { parsed[file] = JSON.parse(raw.toString("utf8")); }
    catch { throw new Error(`TEST_EVIDENCE_CAPTURE_JSON_INVALID:${file}`); }
  }
  validate_cleanup(parsed["capture-cleanup.json"]);
  const reports = Object.fromEntries(categories.map((category) => [category, parsed[`${category}.json`]])) as Partial<Record<Category, JsonObject>>;
  const reportBytes = Object.fromEntries(categories.map((category) => [category, bytes[`${category}.json`]])) as Partial<Record<Category, Buffer>>;
  for (const category of categories) validate_report(category, reports[category]!, metadata, reportBytes[category]!.byteLength);
  const accounting = validate_accounting(reports, metadata);
  const allSuites = categories.flatMap((category) => reports[category]!.suiteRuns.map((suite: JsonObject) => suite.id));
  const allCases = categories.flatMap((category) => reports[category]!.suiteRuns.flatMap((suite: JsonObject) => suite.cases.map((item: JsonObject) => item.id)));
  assert_unique(allSuites, "GLOBAL_SUITE_ID");
  assert_unique(allCases, "GLOBAL_CASE_ID");
  if (options.verifyRevisions !== false) verify_revisions(resolve(options.repositoryRoot ?? join(import.meta.dirname, "../..")), metadata.deployment);
  return Object.freeze({ candidate: resolve(candidate), capture, metadata, categories, cleanup: parsed["capture-cleanup.json"], reports, reportBytes, accounting });
}

function artifact_tuple_digest(records: readonly ArtifactRecord[]): string {
  const tuples = [...records].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map((entry) => `${entry.path}\0${entry.rawBytes}\0${entry.sha256}\n`).join("");
  return sha256(tuples);
}

async function record_file(siteRoot: string, path: string, bytes: Buffer, records: ArtifactRecord[]): Promise<ArtifactRecord> {
  await atomic_write(join(siteRoot, path), bytes);
  const record = Object.freeze({ path, rawBytes: bytes.byteLength, sha256: sha256(bytes) });
  records.push(record);
  return record;
}

function suite_projection(suite: JsonObject): JsonObject {
  const { cases: _cases, evidence: _evidence, evidenceRefs: _evidenceRefs, ...projection } = suite;
  return projection;
}

function status_counts(items: readonly JsonObject[]): JsonObject {
  return Object.freeze({
    total: items.length,
    pass: items.filter((item) => item.status === "pass").length,
    fail: items.filter((item) => item.status === "fail").length,
    skip: items.filter((item) => item.status === "skip").length,
  });
}

export type MaterializationResult = Readonly<{
  candidate: string;
  siteRoot: string;
  evidenceRoot: string;
  publicRoot: string;
  index: JsonObject;
  provenance: JsonObject;
  verification: JsonObject;
}>;

export async function materialize_test_evidence(captureCandidate: string, options: { repositoryRoot?: string; workRoot?: string; materializedAt?: string; verifyRevisions?: boolean } = {}): Promise<MaterializationResult> {
  const repositoryRoot = resolve(options.repositoryRoot ?? join(import.meta.dirname, "../.."));
  const source = await validate_capture(captureCandidate, { repositoryRoot, verifyRevisions: options.verifyRevisions });
  const candidate = join(resolve(options.workRoot ?? join(repositoryRoot, ".deployment-work")), `materialize-${Date.now().toString(36)}-${randomUUID()}`);
  const siteRoot = join(candidate, "site");
  const publicRoot = `test-evidence/${source.metadata.deployment.hsonDeployCommit}`;
  const evidenceRoot = join(siteRoot, publicRoot);
  await mkdir(evidenceRoot, { recursive: true });
  const records: ArtifactRecord[] = [];
  const reportRecords = {} as Record<Category, ArtifactRecord>;
  const suites: JsonObject[] = [];
  let caseArtifactCount = 0;
  let suiteArtifactCount = 0;
  try {
    for (const category of source.categories) {
      reportRecords[category] = await record_file(evidenceRoot, `reports/${category}.json`, source.reportBytes[category]!, records);
      for (const suite of source.reports[category]!.suiteRuns) {
        const evidenceById = new Map(suite.evidence.map((entry: JsonObject) => [entry.id, entry]));
        const childReferences = new Set<string>(suite.cases.flatMap((item: JsonObject) => item.evidenceRefs));
        const ownedReferences = suite.evidenceRefs.filter((id: string) => !childReferences.has(id));
        const ownedEvidence = ownedReferences.map((id: string) => evidenceById.get(id));
        const suitePath = `suites/${encode_artifact_id(suite.id)}.json`;
        let suiteArtifact: ArtifactRecord | null = null;
        if (ownedEvidence.length > 0 || suite.errors.length > 0) {
          suiteArtifact = await record_file(evidenceRoot, suitePath, json_bytes({ category, suiteId: suite.id, suite: suite_projection(suite), evidenceRefs: ownedReferences, evidence: ownedEvidence }), records);
          suiteArtifactCount += 1;
        }
        const indexedCases: JsonObject[] = [];
        for (const item of suite.cases) {
          const retained = item.diagnostic !== null || item.errors.length > 0 || item.evidenceRefs.length > 0;
          const casePath = `cases/${encode_artifact_id(item.id)}.json`;
          let caseArtifact: ArtifactRecord | null = null;
          if (retained) {
            caseArtifact = await record_file(evidenceRoot, casePath, json_bytes({ category, suiteId: suite.id, caseId: item.id, case: item, evidence: item.evidenceRefs.map((id: string) => evidenceById.get(id)) }), records);
            caseArtifactCount += 1;
          }
          indexedCases.push({
            id: item.id, caseId: item.caseId, title: item.title, order: item.order, status: item.status,
            timing: { queuedAt: item.queuedAt, startedAt: item.startedAt, completedAt: item.completedAt, durationMs: item.durationMs, ms: item.ms },
            evidence: caseArtifact === null ? { available: false } : { available: true, ...caseArtifact },
          });
        }
        suites.push({
          category, id: suite.id, title: suite.title, order: suite.order, status: suite.status, executionShape: suite.executionShape,
          counts: suite.counts, timing: { queuedAt: suite.queuedAt, startedAt: suite.startedAt, completedAt: suite.completedAt, durationMs: suite.durationMs, ms: suite.ms },
          evidence: suiteArtifact === null ? { available: false } : { available: true, ...suiteArtifact },
          cases: indexedCases,
        });
      }
    }
    const categories = CATEGORIES.map((category) => {
      const report = source.reports[category];
      if (report === undefined) return {
        id: category, status: "cancelled", suiteCounts: status_counts([]), caseCounts: status_counts([]), summary: { cases: 0, pass: 0, fail: 0, skip: 0 },
        timing: { startedAt: null, completedAt: null, runnerMs: null, hostMs: null }, evidenceAvailable: false, report: { available: false },
      };
      const categorySuites = suites.filter((suite) => suite.category === category);
      const categoryCases = categorySuites.flatMap((suite) => suite.cases);
      return {
        id: category, status: report.run.status, suiteCounts: status_counts(report.suiteRuns), caseCounts: status_counts(categoryCases), summary: report.summary,
        timing: { startedAt: report.run.startedAt, completedAt: report.run.completedAt, runnerMs: report.run.timing?.runnerMs ?? null, hostMs: report.run.timing?.hostMs ?? null },
        evidenceAvailable: categorySuites.some((suite) => suite.evidence.available || suite.cases.some((item: JsonObject) => item.evidence.available)),
        report: { ...reportRecords[category] },
      };
    });
    const index = {
      deployment: source.metadata.deployment,
      capture: { candidateId: basename(source.candidate), capturedAt: source.metadata.capturedAt },
      accounting: source.accounting,
      selectionCategories: [...CATEGORIES],
      categories,
      suites,
    };
    const indexRecord = await record_file(evidenceRoot, "index.json", json_bytes(index), records);
    const artifactSet = { fileCount: records.length, rawBytes: records.reduce((total, entry) => total + entry.rawBytes, 0), sha256: artifact_tuple_digest(records) };
    const provenance = {
      materializedAt: options.materializedAt ?? new Date().toISOString(),
      deployment: source.metadata.deployment,
      runtime: source.metadata.runtime,
      runs: Object.fromEntries(source.categories.map((category) => [category, {
        runId: source.metadata.runs[category].runId,
        reportHostId: source.metadata.runs[category].reportHostId,
        reportRev: source.metadata.runs[category].reportRev,
        reportPath: reportRecords[category].path,
        reportBytes: reportRecords[category].rawBytes,
        reportSha256: reportRecords[category].sha256,
        terminalSummary: category === "certification" ? { status: "passed", certifications: 57 } : { status: "passed", ...source.reports[category]!.summary },
      }])),
      accounting: source.accounting,
      artifactSet,
    };
    await atomic_write(join(evidenceRoot, "provenance.json"), json_bytes(provenance));
    const verification = await verify_materialized_evidence(source, evidenceRoot);
    await atomic_write(join(candidate, "accepted.json"), json_bytes({ accepted: true, evidenceRoot: publicRoot, artifactSet: artifactSet.sha256 }));
    return Object.freeze({ candidate, siteRoot, evidenceRoot, publicRoot, index: { ...index, rawBytes: indexRecord.rawBytes }, provenance, verification: { ...verification, caseArtifactCount, suiteArtifactCount } });
  } catch (error) {
    throw new Error(`TEST_EVIDENCE_MATERIALIZATION_INCOMPLETE:${candidate}`, { cause: error });
  }
}

async function list_files(root: string, directory = root): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await list_files(root, path));
    else output.push(relative(root, path).split(sep).join("/"));
  }
  return output.sort();
}

async function parse_json(path: string): Promise<JsonObject> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error(`TEST_EVIDENCE_ARTIFACT_JSON_INVALID:${path}`); }
}

export async function verify_materialized_evidence(source: ValidatedCapture, evidenceRoot: string): Promise<JsonObject> {
  const index = await parse_json(join(evidenceRoot, "index.json"));
  const provenance = await parse_json(join(evidenceRoot, "provenance.json"));
  assert.deepEqual(index.deployment, source.metadata.deployment, "TEST_EVIDENCE_INDEX_DEPLOYMENT_MUTATED");
  assert.deepEqual(index.accounting, source.accounting, "TEST_EVIDENCE_INDEX_ACCOUNTING_MUTATED");
  assert.deepEqual(provenance.accounting, source.accounting, "TEST_EVIDENCE_PROVENANCE_ACCOUNTING_MUTATED");
  const sourceSuites = source.categories.flatMap((category) => source.reports[category]!.suiteRuns.map((suite: JsonObject) => ({ category, suite })));
  assert.equal(index.suites.length, sourceSuites.length, "TEST_EVIDENCE_INDEX_SUITE_OMISSION");
  assert.deepEqual(index.suites.map((suite: JsonObject) => `${suite.category}\0${suite.id}`), sourceSuites.map(({ category, suite }) => `${category}\0${suite.id}`), "TEST_EVIDENCE_INDEX_SUITE_ORDER_MUTATED");
  let sourceEvidenceCount = 0;
  let projectedEvidenceCount = 0;
  let sourceCaseCount = 0;
  for (const { category, suite } of sourceSuites) {
    const indexed = index.suites.find((entry: JsonObject) => entry.category === category && entry.id === suite.id);
    assert.ok(indexed, `TEST_EVIDENCE_INDEX_SUITE_MISSING:${suite.id}`);
    assert.equal(indexed.status, suite.status, `TEST_EVIDENCE_SUITE_STATUS_MUTATED:${suite.id}`);
    assert.deepEqual(indexed.counts, suite.counts, `TEST_EVIDENCE_SUITE_COUNTS_MUTATED:${suite.id}`);
    assert.deepEqual(indexed.cases.map((item: JsonObject) => item.id), suite.cases.map((item: JsonObject) => item.id), `TEST_EVIDENCE_INDEX_CASE_ORDER_MUTATED:${suite.id}`);
    const evidenceById = new Map(suite.evidence.map((entry: JsonObject) => [entry.id, entry]));
    const childRefs = new Set<string>(suite.cases.flatMap((item: JsonObject) => item.evidenceRefs));
    const suiteRefs = suite.evidenceRefs.filter((id: string) => !childRefs.has(id));
    sourceEvidenceCount += suite.evidence.length;
    sourceCaseCount += suite.cases.length;
    if (suiteRefs.length > 0 || suite.errors.length > 0) {
      assert.equal(indexed.evidence.available, true, `TEST_EVIDENCE_SUITE_ARTIFACT_MISSING:${suite.id}`);
      const artifactBytes = await readFile(join(evidenceRoot, indexed.evidence.path));
      assert.equal(artifactBytes.byteLength, indexed.evidence.rawBytes, `TEST_EVIDENCE_SUITE_SIZE_MISMATCH:${suite.id}`);
      assert.equal(sha256(artifactBytes), indexed.evidence.sha256, `TEST_EVIDENCE_SUITE_HASH_MISMATCH:${suite.id}`);
      const artifact = JSON.parse(artifactBytes.toString("utf8"));
      assert.equal(artifact.suiteId, suite.id, `TEST_EVIDENCE_SUITE_ID_MUTATED:${suite.id}`);
      assert.deepEqual(artifact.evidence, suiteRefs.map((id: string) => evidenceById.get(id)), `TEST_EVIDENCE_SUITE_EVIDENCE_MUTATED:${suite.id}`);
      projectedEvidenceCount += artifact.evidence.length;
    } else assert.equal(indexed.evidence.available, false, `TEST_EVIDENCE_SUITE_ARTIFACT_INVENTED:${suite.id}`);
    for (const item of suite.cases) {
      const indexedCase = indexed.cases.find((entry: JsonObject) => entry.id === item.id);
      assert.ok(indexedCase, `TEST_EVIDENCE_INDEX_CASE_MISSING:${item.id}`);
      assert.equal(indexedCase.status, item.status, `TEST_EVIDENCE_CASE_STATUS_MUTATED:${item.id}`);
      const retained = item.diagnostic !== null || item.errors.length > 0 || item.evidenceRefs.length > 0;
      assert.equal(indexedCase.evidence.available, retained, `TEST_EVIDENCE_CASE_AVAILABILITY_MUTATED:${item.id}`);
      if (retained) {
        const artifactBytes = await readFile(join(evidenceRoot, indexedCase.evidence.path));
        assert.equal(artifactBytes.byteLength, indexedCase.evidence.rawBytes, `TEST_EVIDENCE_CASE_SIZE_MISMATCH:${item.id}`);
        assert.equal(sha256(artifactBytes), indexedCase.evidence.sha256, `TEST_EVIDENCE_CASE_HASH_MISMATCH:${item.id}`);
        const artifact = JSON.parse(artifactBytes.toString("utf8"));
        assert.equal(artifact.caseId, item.id, `TEST_EVIDENCE_CASE_ID_MUTATED:${item.id}`);
        assert.deepEqual(artifact.case, item, `TEST_EVIDENCE_CASE_MUTATED:${item.id}`);
        assert.deepEqual(artifact.evidence, item.evidenceRefs.map((id: string) => evidenceById.get(id)), `TEST_EVIDENCE_CASE_EVIDENCE_MUTATED:${item.id}`);
        projectedEvidenceCount += artifact.evidence.length;
      }
    }
  }
  assert.equal(index.suites.flatMap((suite: JsonObject) => suite.cases).length, sourceCaseCount, "TEST_EVIDENCE_INDEX_CASE_OMISSION");
  assert.equal(projectedEvidenceCount, sourceEvidenceCount, "TEST_EVIDENCE_RETAINED_EVIDENCE_PARTITION");
  for (const category of source.categories) {
    const bytes = await readFile(join(evidenceRoot, `reports/${category}.json`));
    assert.deepEqual(bytes, source.reportBytes[category], `TEST_EVIDENCE_FULL_REPORT_MUTATED:${category}`);
    assert.equal(provenance.runs[category].reportSha256, sha256(bytes), `TEST_EVIDENCE_REPORT_HASH_MUTATED:${category}`);
  }
  const files = (await list_files(evidenceRoot)).filter((path) => path !== "provenance.json");
  const records = await Promise.all(files.map(async (path) => {
    const bytes = await readFile(join(evidenceRoot, path));
    return { path, rawBytes: bytes.byteLength, sha256: sha256(bytes) };
  }));
  assert.equal(provenance.artifactSet.fileCount, records.length, "TEST_EVIDENCE_ARTIFACT_COUNT_MISMATCH");
  assert.equal(provenance.artifactSet.rawBytes, records.reduce((total, entry) => total + entry.rawBytes, 0), "TEST_EVIDENCE_ARTIFACT_BYTES_MISMATCH");
  assert.equal(provenance.artifactSet.sha256, artifact_tuple_digest(records), "TEST_EVIDENCE_ARTIFACT_SET_HASH_MISMATCH");
  return Object.freeze({ suiteCount: sourceSuites.length, caseCount: sourceCaseCount, evidenceEntryCount: sourceEvidenceCount, artifactSetSha256: provenance.artifactSet.sha256 });
}

export async function measure_package(result: MaterializationResult): Promise<JsonObject> {
  const index = await parse_json(join(result.evidenceRoot, "index.json"));
  const caseRecords = index.suites.flatMap((suite: JsonObject) => suite.cases.map((item: JsonObject) => item.evidence).filter((entry: JsonObject) => entry.available));
  const suiteRecords = index.suites.map((suite: JsonObject) => suite.evidence).filter((entry: JsonObject) => entry.available);
  const fullReports = index.categories.map((entry: JsonObject) => entry.report).filter((entry: JsonObject) => entry?.available !== false);
  const allFiles = await list_files(result.evidenceRoot);
  const completeBytes = (await Promise.all(allFiles.map((path) => stat(join(result.evidenceRoot, path))))).reduce((total, item) => total + item.size, 0);
  const largest = (records: JsonObject[]) => records.reduce((current, entry) => entry.rawBytes > current.rawBytes ? entry : current, { rawBytes: 0 });
  return Object.freeze({
    indexRawBytes: (await stat(join(result.evidenceRoot, "index.json"))).size,
    caseArtifacts: { count: caseRecords.length, rawBytes: caseRecords.reduce((total: number, entry: JsonObject) => total + entry.rawBytes, 0), largest: largest(caseRecords) },
    suiteArtifacts: { count: suiteRecords.length, rawBytes: suiteRecords.reduce((total: number, entry: JsonObject) => total + entry.rawBytes, 0), largest: largest(suiteRecords) },
    fullReports: { rawBytes: fullReports.reduce((total: number, entry: JsonObject) => total + entry.rawBytes, 0), largest: largest(fullReports), entries: Object.fromEntries(index.categories.filter((entry: JsonObject) => entry.report?.available !== false).map((entry: JsonObject) => [entry.id, entry.report])) },
    lazyArtifactRawBytes: [...caseRecords, ...suiteRecords].reduce((total: number, entry: JsonObject) => total + entry.rawBytes, 0),
    completePackageRawBytes: completeBytes,
  });
}
