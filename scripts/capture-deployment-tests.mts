import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { arch, platform, version as nodeVersion } from "node:process";
import { basename, dirname, join, resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import WebSocket from "ws";
import type { BrowserWebSocketConstructor } from "../hson-demo2/src/app/demos/tests/hosted-client/browser-websocket-socket";
import { make_hosted_test_panel_adapter, type HostedTestPanelSink } from "../hson-demo2/src/app/demos/tests/panel/hosted-test-panel-adapter";
import { make_remote_hosted_test_runtime } from "../hson-demo2/src/app/demos/tests/panel/hosted-test-panel-runtime";
import { hosted_test_projection_summary } from "../hson-demo2/src/app/demos/tests/panel/hosted-test-report-summary";
import type { HostedTestReport } from "../hson-demo2/src/shared/hosted-tests/hosted-test-report.types";
import type { TestExecutorDiscovery } from "../hson-demo2/src/shared/testing/test-discovery-contract";
import type { HostedTestTimelineEvent } from "../hson-demo2/src/shared/hosted-tests/hosted-test-timeline";
import { start_hosted_test_server } from "../hson-demo2/tests/harness/runtimes/node/server/hosted-test-server";
import { BROWSER_SUITE_MANIFEST } from "../hson-demo2/tests/harness/runtimes/node/browser/browser-test-manifest";
import { build_test_surface_census, classify_certification_surface, reconcile_certification_accounting } from "../hson-demo2/tests/harness/hosted/test-surface-census";

const ROOT = resolve(import.meta.dirname, "..");
const DEMO = join(ROOT, "hson-demo2");
type Name = "semantic" | "browser" | "certification";
type Selection = Readonly<{ name: Name; ids: readonly string[] }>;
export type DeploymentCaptureOptions = Readonly<{ stages?: readonly Name[] }>;
type EvidenceClassification = Readonly<{ selfContained: number; transientIrrelevant: number; transientRequired: number }>;
type CertificationAccounting = Readonly<{ h2b: number; h2c: number; h2d: number; remaining: number }>;

function git(args: readonly string[], cwd = ROOT): string { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function state() {
  if (git(["status", "--porcelain"]) !== "") throw new Error("DEPLOYMENT_CAPTURE_PARENT_DIRTY");
  const links: Record<string, string> = {};
  for (const path of ["hson-demo2", "hson-live", "intrastructure"]) {
    const expected = git(["ls-tree", "HEAD", path]).split(/\s+/)[2];
    const actual = git(["rev-parse", "HEAD"], join(ROOT, path));
    if (expected !== actual || git(["status", "--porcelain"], join(ROOT, path)) !== "") throw new Error(`DEPLOYMENT_CAPTURE_SUBMODULE_INVALID:${path}`);
    links[path] = actual;
  }
  return Object.freeze({ hsonDeployCommit: git(["rev-parse", "HEAD"]), hsonDemo2Gitlink: links["hson-demo2"], hsonLiveGitlink: links["hson-live"], intrastructureGitlink: links.intrastructure });
}
function unique<T extends string>(ids: readonly T[], name: string) { if (new Set(ids).size !== ids.length) throw new Error(`DEPLOYMENT_CAPTURE_DUPLICATE:${name}`); return Object.freeze([...ids]); }
export function derive_selections(discovery: TestExecutorDiscovery): readonly Selection[] {
  const suites = new Map(discovery.catalog.suites.map((suite) => [suite.id, suite]));
  if (suites.size !== discovery.catalog.suites.length) throw new Error("DEPLOYMENT_CAPTURE_DUPLICATE_SUITE");
  const caseIds = (shape: string) => discovery.catalog.tests.filter((test) => suites.get(test.suiteId)?.executionShape === shape).map((test) => test.id);
  const semantic = [...caseIds("cases"), ...discovery.catalog.suites.filter((suite) => suite.executionShape === "opaque-aggregate").map((suite) => suite.id)];
  const browser = caseIds("browser-journeys");
  const certificationSuites = discovery.catalog.suites.filter((suite) => suite.executionShape === "certification-aggregate" && !suite.requirements.includes("dynamic-generated"));
  const certification = certificationSuites.map((suite) => {
    if (!suite.sourceRef?.startsWith("node-command:")) throw new Error(`DEPLOYMENT_CAPTURE_CERTIFICATION_SOURCE:${suite.id}`);
    return suite.id;
  });
  unique(certificationSuites.map((suite) => suite.sourceRef!), "certification-source-ref");
  if (!semantic.length || !browser.length || !certification.length) throw new Error("DEPLOYMENT_CAPTURE_EMPTY_SELECTION");
  return Object.freeze([Object.freeze({ name: "semantic" as const, ids: unique(semantic, "semantic") }), Object.freeze({ name: "browser" as const, ids: unique(browser, "browser") }), Object.freeze({ name: "certification" as const, ids: unique(certification, "certification") })]);
}
function certification_accounting(discovery: TestExecutorDiscovery, selection: readonly string[]): CertificationAccounting {
  const census = build_test_surface_census(BROWSER_SUITE_MANIFEST.map((suite) => ({ path: suite.path, cases: suite.journeys.length })));
  const accounting = reconcile_certification_accounting(census);
  const supported = census.filter((entry) => classify_certification_surface(entry) === "SUPPORTED_CERTIFICATION" && entry.currentLocalLocusAvailability)
    .map((entry) => entry.id);
  const selectedSources = discovery.catalog.suites.filter((suite) => selection.includes(suite.id)).map((suite) => suite.sourceRef?.slice("node-command:".length));
  assert.equal(selectedSources.every((source) => source !== undefined), true, "DEPLOYMENT_CAPTURE_CERTIFICATION_SOURCE_MISSING");
  assert.deepEqual([...selectedSources].sort(), [...supported].sort(), "DEPLOYMENT_CAPTURE_CERTIFICATION_CENSUS_MISMATCH");
  assert.equal(selection.length, 57, "DEPLOYMENT_CAPTURE_CERTIFICATION_DENOMINATOR_DRIFT");
  assert.equal(accounting.supportedCertifications, 57, "DEPLOYMENT_CAPTURE_CERTIFICATION_ACCOUNTING_DRIFT");
  assert.equal(accounting.h2bSupportedAdditions, 10, "DEPLOYMENT_CAPTURE_H2B_DRIFT");
  assert.equal(accounting.h2cSupportedAdditions, 11, "DEPLOYMENT_CAPTURE_H2C_DRIFT");
  assert.equal(accounting.h2dSupportedAdditions, 7, "DEPLOYMENT_CAPTURE_H2D_DRIFT");
  assert.equal(accounting.remainingH2CD, 0, "DEPLOYMENT_CAPTURE_H2_REMAINING");
  assert.equal(discovery.catalog.suites.filter((suite) => suite.executionShape === "certification-aggregate" && suite.requirements.includes("dynamic-generated")).length > 0, true, "DEPLOYMENT_CAPTURE_DYNAMIC_SURFACE_MISSING");
  return Object.freeze({ h2b: accounting.h2bSupportedAdditions, h2c: accounting.h2cSupportedAdditions, h2d: accounting.h2dSupportedAdditions, remaining: accounting.remainingH2CD });
}
async function atomic(path: string, value: unknown) { const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); const temp = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`); await writeFile(temp, bytes, { flag: "wx" }); JSON.parse(await readFile(temp, "utf8")); await rename(temp, path); return bytes.byteLength; }
async function revalidate(path: string): Promise<HostedTestReport> { return JSON.parse(await readFile(path, "utf8")) as HostedTestReport; }
async function wait_for_client_close(server: Awaited<ReturnType<typeof start_hosted_test_server>>): Promise<ReturnType<typeof server.connectionSnapshot>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = server.connectionSnapshot();
    if (snapshot.total === 0) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("DEPLOYMENT_CAPTURE_CLIENT_SOCKETS_REMAIN");
}
function failed_report_summary(report: HostedTestReport | undefined) {
  if (report === undefined) return undefined;
  return {
    terminalStatus: report.run.status,
    summary: report.summary,
    failingSuites: report.suiteRuns.filter((suite) => suite.status !== "pass").map((suite) => ({
      id: suite.id, status: suite.status, errors: suite.errors, evidence: suite.evidence,
      failingCases: suite.cases.filter((test) => test.status !== "pass").map((test) => ({ id: test.id, status: test.status, err: test.err, errors: test.errors, evidenceRefs: test.evidenceRefs })),
    })),
  };
}
function evidence_classification(report: HostedTestReport): EvidenceClassification {
  const evidence = report.suiteRuns.flatMap((suite) => suite.evidence);
  const referenced = new Set(report.suiteRuns.flatMap((suite) => [
    ...suite.evidenceRefs,
    ...suite.cases.flatMap((test) => test.evidenceRefs),
  ]));
  const ids = new Set(evidence.map((entry) => entry.id));
  assert.equal(ids.size, evidence.length, "report evidence IDs must be unique");
  for (const id of referenced) assert.ok(ids.has(id), `report evidence reference is missing: ${id}`);
  const classification = evidence.reduce((counts, entry) => {
    if (entry.content.length > 0 || entry.reference === null) return { ...counts, selfContained: counts.selfContained + 1 };
    if (referenced.has(entry.id)) return { ...counts, transientRequired: counts.transientRequired + 1 };
    return { ...counts, transientIrrelevant: counts.transientIrrelevant + 1 };
  }, { selfContained: 0, transientIrrelevant: 0, transientRequired: 0 });
  assert.equal(classification.transientRequired, 0, "DEPLOYMENT_CAPTURE_TRANSIENT_REQUIRED_EVIDENCE");
  return Object.freeze(classification);
}
function validate(name: Name, intended: readonly string[], report: HostedTestReport, result: any) {
  assert.equal(report.run.status, "passed"); assert.equal(result.ok, true); assert.equal(result.runId, report.run.id); assert.ok(result.reportHostId); assert.ok(result.reportRev !== undefined); assert.deepEqual([...report.plan.selectionIds].sort(), [...intended].sort());
  assert.deepEqual([...result.selectionIds].sort(), [...intended].sort());
  assert.equal(report.summary.fail, 0); assert.equal(report.summary.skip, 0); assert.equal(report.suiteRuns.every((suite) => suite.status === "pass"), true);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report, "report must be JSON-safe without lossy fields");
  const summary = hosted_test_projection_summary(report);
  if (name === "semantic") { assert.equal(summary.canonical.pass, summary.canonical.total); assert.equal(summary.launchers.passedChecks, summary.launchers.declaredChecks); assert.equal(report.suiteRuns.filter((suite) => suite.executionShape === "cases").every((suite) => suite.cases.every((test) => test.diagnostic !== null)), true); }
  if (name === "browser") {
    const browserCases = report.suiteRuns.flatMap((suite) => suite.cases);
    assert.equal(report.suiteRuns.every((suite) => suite.executionShape === "browser-journeys"), true, "browser capture contains a non-browser suite");
    assert.equal(browserCases.length, intended.length, "every browser journey must have one report case");
    assert.deepEqual(browserCases.map((test) => test.id).sort(), [...intended].sort(), "browser journey report identity must exactly match selection");
    assert.equal(summary.browser.pass, intended.length);
  }
  if (name === "certification") {
    assert.equal(summary.certifications.pass, intended.length);
    assert.equal(report.suiteRuns.length, intended.length, "every certification must have one suite run");
    assert.equal(report.suiteRuns.every((suite) => suite.executionShape === "certification-aggregate"), true, "certification capture contains a non-certification suite");
    assert.equal(report.suiteRuns.every((suite) => suite.sourceRef?.startsWith("node-command:") && !suite.id.includes("generated-json")), true, "certification capture has an invalid source or dynamic surface");
  }
}
function certification_metrics(report: HostedTestReport, raw: Buffer) {
  const suiteBytes = report.suiteRuns.map((suite) => ({ id: suite.id, bytes: Buffer.byteLength(JSON.stringify(suite)) }));
  const outputBytes = report.suiteRuns.map((suite) => ({ id: suite.id, bytes: suite.evidence.filter((entry) => entry.kind === "stdout" || entry.kind === "stderr" || entry.kind === "raw_process_output").reduce((total, entry) => total + Buffer.byteLength(entry.content), 0) }));
  const largest = <T extends { bytes: number }>(values: readonly T[]) => values.reduce((current, value) => value.bytes > current.bytes ? value : current);
  return Object.freeze({ rawBytes: raw.byteLength, gzipBytes: gzipSync(raw).byteLength, brotliBytes: brotliCompressSync(raw).byteLength, suiteCount: report.suiteRuns.length, evidenceEntries: report.suiteRuns.reduce((total, suite) => total + suite.evidence.length, 0), largestConstituent: largest(suiteBytes), largestOutputBearingConstituent: largest(outputBytes) });
}
function stage_name(event: HostedTestTimelineEvent): string | undefined {
  const names: Partial<Record<HostedTestTimelineEvent["stage"], string>> = {
    coordinator_association_committed: "association",
    browser_received_first_report_frame: "report-attach",
    report_client_ready: "ready",
    first_suite_or_case_started: "browser-execution-start",
    report_terminal_committed: "browser-execution-terminal",
    run_finished: "report-settle",
    panel_run_completed: "action-acknowledgment",
  };
  return names[event.stage];
}
export function parse_capture_stages(arguments_: readonly string[]): readonly Name[] | undefined {
  if (arguments_.length === 0) return undefined;
  const aliases: Readonly<Record<string, Name>> = Object.freeze({ "--semantic-only": "semantic", "--browser-only": "browser", "--certification-only": "certification" });
  const stages = arguments_.map((argument) => aliases[argument] ?? (argument.startsWith("--stage=") ? argument.slice("--stage=".length) : argument)) as Name[];
  unique(stages, "requested-stages");
  if (stages.some((stage) => stage !== "semantic" && stage !== "browser" && stage !== "certification")) throw new Error("DEPLOYMENT_CAPTURE_UNKNOWN_STAGE");
  return Object.freeze(stages);
}
export async function capture_deployment_tests(options: DeploymentCaptureOptions = {}) {
  const requestedStages = options.stages === undefined ? undefined : unique(options.stages, "requested-stages");
  if (requestedStages?.some((stage) => stage !== "semantic" && stage !== "browser" && stage !== "certification")) {
    throw new Error("DEPLOYMENT_CAPTURE_UNKNOWN_STAGE");
  }
  const before = state(); const candidate = join(ROOT, ".deployment-work", `capture-${Date.now().toString(36)}-${crypto.randomUUID()}`); const capture = join(candidate, "capture"); await mkdir(capture, { recursive: true }); const cwd = process.cwd(); let stage = "server-start"; let server: Awaited<ReturnType<typeof start_hosted_test_server>> | undefined; let runtime: ReturnType<typeof make_remote_hosted_test_runtime> | undefined; let adapter: ReturnType<typeof make_hosted_test_panel_adapter> | undefined; const observedStages: string[] = []; const timeline: HostedTestTimelineEvent[] = []; const observe = (event: HostedTestTimelineEvent) => { timeline.push(event); const named = stage_name(event); if (named !== undefined) observedStages.push(named); }; let cleanup: Record<string, unknown> | undefined; let latestReport: HostedTestReport | undefined; let selection: Record<string, unknown> | undefined;
  try {
    process.chdir(DEMO); server = await start_hosted_test_server({ host: "127.0.0.1", port: 0, shutdownTimeoutMs: 15_000, retainRichDiagnostics: true, timeline: observe, authorityLifecycle: { maxTowlRooms: 8, towlIdleMs: 30_000, maxHostedReports: 8, hostedReportRetentionMs: 3_600_000, sweepIntervalMs: 30_000 } });
    stage = "runtime-ready"; runtime = make_remote_hosted_test_runtime({ url: server.url, environment: { DEV: true, PROD: false }, WebSocketConstructor: WebSocket as unknown as BrowserWebSocketConstructor, reconnectDelaysMs: [0, 5, 20], timeline: observe }); adapter = make_hosted_test_panel_adapter(runtime, Object.freeze({ reset() {}, ingest() {}, showInfrastructureError(message) { throw new Error(message); } })); await runtime.ready(); stage = "selection"; const discovery = await runtime.discover(); const selections = derive_selections(discovery); const certification = certification_accounting(discovery, selections.find((selected) => selected.name === "certification")!.ids); selection = Object.fromEntries(selections.map((selected) => [selected.name, { idCount: selected.ids.length, ids: selected.ids, ...(selected.name === "certification" ? { h2: certification } : {}) }])); const runs: Record<string, unknown> = {};
    for (const selected of selections) { if (requestedStages && !requestedStages.includes(selected.name)) continue; stage = `${selected.name}:association`; const result = await adapter.start_selected(selected.ids); stage = `${selected.name}:validation`; const report = adapter.capture(); if (!report) throw new Error(`DEPLOYMENT_CAPTURE_MISSING:${selected.name}`); const snapshot = JSON.parse(JSON.stringify(report)) as HostedTestReport; latestReport = snapshot; validate(selected.name, selected.ids, snapshot, result); const evidence = evidence_classification(snapshot); stage = `${selected.name}:atomic-write`; const reportFile = `${selected.name}.json`; const reportPath = join(capture, reportFile); const rawBytes = await atomic(reportPath, snapshot); const revalidated = await revalidate(reportPath); assert.deepEqual(revalidated, snapshot, "atomically written report must independently revalidate"); runs[selected.name] = { runId: result.runId, attemptId: result.attemptId, reportHostId: result.reportHostId, reportRev: result.reportRev, clientAppliedReportRev: result.reportRev, reportFile, selectionCount: selected.ids.length, journeyCount: selected.name === "browser" ? snapshot.suiteRuns.flatMap((suite) => suite.cases).length : undefined, terminalStatus: snapshot.run.status, rawBytes, evidence, ...(selected.name === "certification" ? { metrics: certification_metrics(snapshot, Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`)) } : {}) }; }
    stage = "metadata-write"; await atomic(join(capture, "capture-metadata.json"), { capturedAt: new Date().toISOString(), deployment: before, runtime: { nodeVersion, platform, architecture: arch }, selectedStages: requestedStages ?? selections.map((selected) => selected.name), selectionSource: "runtime.tests.discover catalog executionShape classification", selection, observedStages, timeline, runs }); return candidate;
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    await atomic(join(candidate, "capture-diagnostics.json"), { failedStage: stage, selection, observedStages, timeline, browserCorpus: failed_report_summary(latestReport), error: { name: cause.name, message: cause.message, stack: cause.stack } });
    throw error;
  } finally { stage = "cleanup"; adapter?.dispose(); runtime?.dispose(); if (server) { const clientSockets = await wait_for_client_close(server); await server.stop(); const browser = server.browserMetrics?.(); if (browser) { assert.equal(browser.activeProcesses, 0); assert.equal(browser.activeJourneys, 0); assert.equal(browser.retainedArtifactRoots, 0); } cleanup = { clientSockets, browser }; } process.chdir(cwd); assert.deepEqual(state(), before); if (cleanup !== undefined) await atomic(join(capture, "capture-cleanup.json"), cleanup); }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const stages = parse_capture_stages(process.argv.slice(2));
  capture_deployment_tests(stages === undefined ? {} : { stages }).then((candidate) => console.log(candidate));
}
