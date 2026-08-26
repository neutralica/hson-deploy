import assert from "node:assert/strict";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { arch, platform, version as nodeVersion } from "node:process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { create_node_process_supervisor, type NodeProcessSupervisor } from "../hson-demo2/tests/harness/runtimes/node/node-process-supervisor";
import { assert_exact_selected_results } from "./test-evidence/selection-accounting.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const DEMO = join(ROOT, "hson-demo2");
const WORK_ROOT = join(ROOT, ".deployment-work");
type Name = "semantic" | "browser" | "certification";
type Selection = Readonly<{ name: Name; ids: readonly string[] }>;
export type DeploymentCaptureOptions = Readonly<{
  stages?: readonly Name[];
  /** Private focused-verification seam; every override must be a discovered member of its stage. */
  selectionOverrides?: Readonly<Partial<Record<Name, readonly string[]>>>;
  /** Private regression seam; validates a real run against a different discovered selection. */
  validationExpectedSelectionOverrides?: Readonly<Partial<Record<Name, readonly string[]>>>;
}>;
type EvidenceClassification = Readonly<{ selfContained: number; transientIrrelevant: number; transientRequired: number }>;
type DeploymentState = Readonly<{ hsonDeployCommit: string; hsonDemo2Gitlink: string; hsonLiveGitlink: string; intrastructureGitlink: string }>;

const CAPTURE_STATE_COMMAND_TIMEOUT_MS = 30_000;
const CAPTURE_STATE_DISPOSAL_TIMEOUT_MS = 3_000;
export const DEPLOYMENT_CAPTURE_TERMINAL_OUTPUT_LIMIT_BYTES = 16 * 1024;
const DEPLOYMENT_CAPTURE_TERMINAL_TRUNCATION = "\n<DEPLOYMENT_CAPTURE_TERMINAL_OUTPUT_TRUNCATED>\n";
const DEPLOYMENT_CAPTURE_CAUSE_OUTPUT_LIMIT_BYTES = 4 * 1024;
const DEPLOYMENT_CAPTURE_CAUSE_TRUNCATION = "\n<DEPLOYMENT_CAPTURE_CAUSE_TRUNCATED>";
const INTERNAL_CLI_TRACE_ENABLED = process.env.DEPLOYMENT_CAPTURE_INTERNAL_CLI_TRACE === "1";
let internalCliTrace: { path: string; sequence: number } | undefined;

function capture_identity(): Readonly<{ captureId: string; candidate: string }> {
  const captureId = process.env.HSON_CERTIFICATION_CAPTURE_ID ?? crypto.randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(captureId)) throw new Error("DEPLOYMENT_CAPTURE_ID_INVALID");
  const configured = process.env.HSON_CERTIFICATION_CAPTURE_CANDIDATE;
  const candidate = resolve(configured ?? join(WORK_ROOT, `capture-${Date.now().toString(36)}-${captureId}`));
  if (dirname(candidate) !== WORK_ROOT || !basename(candidate).endsWith(captureId)) throw new Error("DEPLOYMENT_CAPTURE_CANDIDATE_INVALID");
  mkdirSync(WORK_ROOT, { recursive: true });
  mkdirSync(candidate);
  const capture = join(candidate, "capture");
  mkdirSync(capture);
  return Object.freeze({ captureId, candidate });
}

function empty_cleanup(captureId: string): Record<string, unknown> {
  return {
    captureId,
    clientSockets: { total: 0, hostedTests: { total: 0 }, towl: 0, circuitVerification: 0 },
    browser: { activeProcesses: 0, activeJourneys: 0, retainedArtifactRoots: 0, forcedTerminations: 0 },
  };
}

type InternalCliTraceCheckpoint =
  | "capture-terminal-written"
  | "finally-complete"
  | "capture-function-resolved"
  | "run-command-resolved"
  | "main-result-received"
  | "final-output-begin"
  | "final-output-complete";

function initialize_internal_cli_trace(capture: string): void {
  if (!INTERNAL_CLI_TRACE_ENABLED) return;
  internalCliTrace = { path: join(capture, "capture-cli-trace.jsonl"), sequence: 0 };
}

function trace_internal_cli(checkpoint: InternalCliTraceCheckpoint): void {
  if (internalCliTrace === undefined) return;
  const entry = Object.freeze({
    sequence: internalCliTrace.sequence += 1,
    checkpoint,
    pid: process.pid,
    timestamp: new Date().toISOString(),
  });
  const descriptor = openSync(internalCliTrace.path, "a", 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(entry)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function create_capture_state_supervisor(): NodeProcessSupervisor {
  return create_node_process_supervisor({
    stdoutLimitBytes: 16 * 1024 * 1024,
    stderrLimitBytes: 1024 * 1024,
    truncationMarker: "<DEPLOYMENT_CAPTURE_STATE_OUTPUT_TRUNCATED>",
    terminationGraceMs: 1_000,
  });
}

async function dispose_capture_state_supervisor(supervisor: NodeProcessSupervisor): Promise<void> {
  supervisor.dispose();
  const deadline = Date.now() + CAPTURE_STATE_DISPOSAL_TIMEOUT_MS;
  while (supervisor.metrics().activeChildren !== 0) {
    if (Date.now() >= deadline) throw new Error(`DEPLOYMENT_CAPTURE_STATE_CHILD_REAP_FAILED:${supervisor.metrics().activeChildren}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function git(supervisor: NodeProcessSupervisor, args: readonly string[], cwd = ROOT): Promise<string> {
  const result = await supervisor.start({ cwd, command: "git", args, environment: {}, timeoutMs: CAPTURE_STATE_COMMAND_TIMEOUT_MS }).result;
  if (!result.ok) {
    const detail = [result.spawnError, result.timedOut ? "timed out" : "", result.stderr].filter(Boolean).join("\n");
    throw new Error(`DEPLOYMENT_CAPTURE_STATE_COMMAND_FAILED:git ${args.join(" ")}${detail === "" ? "" : `\n${detail}`}`);
  }
  return result.stdout.trim();
}

async function state(supervisor: NodeProcessSupervisor): Promise<DeploymentState> {
  if (await git(supervisor, ["status", "--porcelain"]) !== "") throw new Error("DEPLOYMENT_CAPTURE_PARENT_DIRTY");
  const links: Record<string, string> = {};
  for (const path of ["hson-demo2", "hson-live", "intrastructure"]) {
    const expected = (await git(supervisor, ["ls-tree", "HEAD", path])).split(/\s+/)[2];
    const actual = await git(supervisor, ["rev-parse", "HEAD"], join(ROOT, path));
    if (expected !== actual || await git(supervisor, ["status", "--porcelain"], join(ROOT, path)) !== "") throw new Error(`DEPLOYMENT_CAPTURE_SUBMODULE_INVALID:${path}`);
    links[path] = actual;
  }
  return Object.freeze({ hsonDeployCommit: await git(supervisor, ["rev-parse", "HEAD"]), hsonDemo2Gitlink: links["hson-demo2"], hsonLiveGitlink: links["hson-live"], intrastructureGitlink: links.intrastructure });
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
async function atomic(path: string, value: unknown) { const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); const temp = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`); await writeFile(temp, bytes, { flag: "wx" }); JSON.parse(await readFile(temp, "utf8")); await rename(temp, path); return bytes.byteLength; }
function atomic_sync(path: string, value: unknown) { const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); const temp = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`); writeFileSync(temp, bytes, { flag: "wx" }); JSON.parse(readFileSync(temp, "utf8")); renameSync(temp, path); return bytes.byteLength; }
function persist_capture_terminal(path: string, value: unknown): number {
  const bytes = atomic_sync(path, value);
  record_command_checkpoint("terminal-file-written", injected_command_dependencies().checkpoint);
  return bytes;
}
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

function failing_suite_ids_from_error(error: Error): readonly string[] {
  const marker = "DEPLOYMENT_CAPTURE_REPORT_FAILED:";
  if (!error.message.startsWith(marker)) return Object.freeze([]);
  const jsonStart = error.message.indexOf(":{", marker.length);
  if (jsonStart < 0) return Object.freeze([]);
  try {
    const summary = JSON.parse(error.message.slice(jsonStart + 1)) as {
      failingSuites?: readonly Readonly<{ id?: unknown }>[];
    };
    return Object.freeze((summary.failingSuites ?? []).flatMap((suite) =>
      typeof suite.id === "string" ? [suite.id] : []
    ));
  } catch {
    return Object.freeze([]);
  }
}

class DeploymentCaptureFailure extends Error {
  readonly candidate: string;
  readonly failedStage: string;
  readonly failingSuiteIds: readonly string[];

  constructor(candidate: string, failedStage: string, cause: Error) {
    super(cause.message, { cause });
    this.name = cause.name;
    this.candidate = candidate;
    this.failedStage = failedStage;
    this.failingSuiteIds = failing_suite_ids_from_error(cause);
  }
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
  if (report.run.status !== "passed") {
    throw new Error(`DEPLOYMENT_CAPTURE_REPORT_FAILED:${name}:${JSON.stringify(failed_report_summary(report))}`);
  }
  assert.equal(report.run.status, "passed"); assert.equal(result.ok, true); assert.equal(result.runId, report.run.id); assert.ok(result.reportHostId); assert.ok(result.reportRev !== undefined); assert.deepEqual([...report.plan.selectionIds].sort(), [...intended].sort());
  assert.deepEqual([...result.selectionIds].sort(), [...intended].sort());
  assert_exact_selected_results(intended, report.suiteRuns, name);
  assert.equal(report.summary.fail, 0); assert.equal(report.summary.skip, 0); assert.equal(report.suiteRuns.every((suite) => suite.status === "pass"), true);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report, "report must be JSON-safe without lossy fields");
  const summary = hosted_test_projection_summary(report);
  if (name === "semantic") { assert.equal(summary.canonical.pass, summary.canonical.total); assert.equal(summary.launchers.passedChecks, summary.launchers.observedChecks); assert.equal(report.suiteRuns.filter((suite) => suite.executionShape === "cases").every((suite) => suite.cases.every((test) => test.diagnostic !== null)), true); }
  if (name === "browser") {
    assert.equal(report.suiteRuns.every((suite) => suite.executionShape === "browser-journeys"), true, "browser capture contains a non-browser suite");
    assert.equal(summary.browser.pass, intended.length);
  }
  if (name === "certification") {
    assert.equal(summary.certifications.pass, intended.length);
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

type CaptureSelectionAdapter = Readonly<{
  start_selected(selectionIds: readonly string[]): Promise<any>;
  capture(): HostedTestReport | undefined;
}>;

export async function capture_deployment_selection(
  selected: Selection,
  capture: string,
  adapter: CaptureSelectionAdapter,
  observeStage: (stage: string) => void = () => undefined,
  validationExpectedIds: readonly string[] = selected.ids,
): Promise<Readonly<{ report: HostedTestReport; run: Record<string, unknown> }>> {
  observeStage(`${selected.name}:association`);
  const result = await adapter.start_selected(selected.ids);
  observeStage(`${selected.name}:validation`);
  const report = adapter.capture();
  if (!report) throw new Error(`DEPLOYMENT_CAPTURE_MISSING:${selected.name}`);
  const snapshot = JSON.parse(JSON.stringify(report)) as HostedTestReport;
  validate(selected.name, validationExpectedIds, snapshot, result);
  const evidence = evidence_classification(snapshot);
  observeStage(`${selected.name}:atomic-write`);
  const reportFile = `${selected.name}.json`;
  const reportPath = join(capture, reportFile);
  const rawBytes = await atomic(reportPath, snapshot);
  const revalidated = await revalidate(reportPath);
  assert.deepEqual(revalidated, snapshot, "atomically written report must independently revalidate");
  return Object.freeze({
    report: snapshot,
    run: {
      runId: result.runId,
      attemptId: result.attemptId,
      reportHostId: result.reportHostId,
      reportRev: result.reportRev,
      clientAppliedReportRev: result.reportRev,
      reportFile,
      selectionCount: selected.ids.length,
      journeyCount: selected.name === "browser" ? snapshot.suiteRuns.flatMap((suite) => suite.cases).length : undefined,
      terminalStatus: snapshot.run.status,
      rawBytes,
      evidence,
      ...(selected.name === "certification" ? { metrics: certification_metrics(snapshot, Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`)) } : {}),
    },
  });
}

export async function capture_deployment_tests(options: DeploymentCaptureOptions = {}) {
  const requestedStages = options.stages === undefined ? undefined : unique(options.stages, "requested-stages");
  if (requestedStages?.some((stage) => stage !== "semantic" && stage !== "browser" && stage !== "certification")) {
    throw new Error("DEPLOYMENT_CAPTURE_UNKNOWN_STAGE");
  }
  const { captureId, candidate } = capture_identity(); const capture = join(candidate, "capture"); initialize_internal_cli_trace(capture); const preflightPath = join(candidate, "capture-preflight.json"); const preflightStartedAt = new Date().toISOString(); atomic_sync(preflightPath, { captureId, status: "started", startedAt: preflightStartedAt, stage: "preflight-state" }); const cwd = process.cwd(); const stateSupervisor = create_capture_state_supervisor(); let before: DeploymentState | undefined; let preflightCompleted = false; let sourceRevalidated = false; let stage = "preflight-state"; let server: Awaited<ReturnType<typeof start_hosted_test_server>> | undefined; let runtime: ReturnType<typeof make_remote_hosted_test_runtime> | undefined; let adapter: ReturnType<typeof make_hosted_test_panel_adapter> | undefined; const observedStages: string[] = []; const timeline: HostedTestTimelineEvent[] = []; const observe = (event: HostedTestTimelineEvent) => { timeline.push(event); const named = stage_name(event); if (named !== undefined) observedStages.push(named); }; let cleanup: Record<string, unknown> = empty_cleanup(captureId); let cleanupPersisted = false; let latestReport: HostedTestReport | undefined; let selection: Record<string, unknown> | undefined; let captureFailure: unknown; let cleanupFailure: unknown;
  try {
    before = await state(stateSupervisor);
    preflightCompleted = true;
    atomic_sync(preflightPath, { captureId, status: "passed", startedAt: preflightStartedAt, completedAt: new Date().toISOString(), stage: "preflight-state", deployment: before });
    stage = "server-start";
    process.chdir(DEMO); server = await start_hosted_test_server({ host: "127.0.0.1", port: 0, shutdownTimeoutMs: 15_000, retainRichDiagnostics: true, timeline: observe, authorityLifecycle: { maxTowlRooms: 8, towlIdleMs: 30_000, maxHostedReports: 8, hostedReportRetentionMs: 3_600_000, sweepIntervalMs: 30_000 } });
    stage = "runtime-ready"; runtime = make_remote_hosted_test_runtime({ url: server.url, environment: { DEV: true, PROD: false }, WebSocketConstructor: WebSocket as unknown as BrowserWebSocketConstructor, reconnectDelaysMs: [0, 5, 20], timeline: observe }); adapter = make_hosted_test_panel_adapter(runtime, Object.freeze({ reset() {}, ingest() {}, showInfrastructureError(message) { throw new Error(message); } })); await runtime.ready(); stage = "selection"; const discovery = await runtime.discover(); const selections = derive_selections(discovery); const stagedSelections = requestedStages === undefined ? selections : selections.filter((selected) => requestedStages.includes(selected.name)); const activeSelections = stagedSelections.map((selected) => {
      const override = options.selectionOverrides?.[selected.name];
      if (override === undefined) return selected;
      const ids = unique(override, `${selected.name}-override`);
      if (ids.length === 0) throw new Error(`DEPLOYMENT_CAPTURE_EMPTY_SELECTION_OVERRIDE:${selected.name}`);
      const allowed = new Set(selected.ids);
      const invalid = ids.find((id) => !allowed.has(id));
      if (invalid !== undefined) throw new Error(`DEPLOYMENT_CAPTURE_SELECTION_OVERRIDE_INVALID:${selected.name}:${invalid}`);
      return Object.freeze({ name: selected.name, ids });
    }); selection = Object.fromEntries(activeSelections.map((selected) => [selected.name, { idCount: selected.ids.length, ids: selected.ids }])); const runs: Record<string, unknown> = {};
    for (const selected of activeSelections) {
      const validationExpectedOverride = options.validationExpectedSelectionOverrides?.[selected.name];
      const validationExpectedIds = validationExpectedOverride === undefined
        ? selected.ids
        : unique(validationExpectedOverride, `${selected.name}-validation-expected-override`);
      const allowedValidationIds = new Set(selections.find((candidate) => candidate.name === selected.name)?.ids ?? []);
      const invalidValidationId = validationExpectedIds.find((id) => !allowedValidationIds.has(id));
      if (validationExpectedIds.length === 0 || invalidValidationId !== undefined) {
        throw new Error(`DEPLOYMENT_CAPTURE_VALIDATION_EXPECTED_OVERRIDE_INVALID:${selected.name}:${invalidValidationId ?? "empty"}`);
      }
      const captured = await capture_deployment_selection(selected, capture, adapter, (value) => { stage = value; }, validationExpectedIds);
      latestReport = captured.report;
      runs[selected.name] = captured.run;
    }
    stage = "metadata-write"; await atomic(join(capture, "capture-metadata.json"), { captureId, capturedAt: new Date().toISOString(), deployment: before, runtime: { nodeVersion, platform, architecture: arch }, selectedStages: requestedStages ?? selections.map((selected) => selected.name), selectionSource: "runtime.tests.discover catalog executionShape classification", selection, observedStages, timeline, runs });
  } catch (error) {
    captureFailure = error;
    const cause = error instanceof Error ? error : new Error(String(error));
    if (!preflightCompleted) atomic_sync(preflightPath, { captureId, status: "failed", startedAt: preflightStartedAt, completedAt: new Date().toISOString(), stage: "preflight-state", error: { name: cause.name, message: cause.message } });
    atomic_sync(join(candidate, "capture-diagnostics.json"), { captureId, failedStage: stage, selection, observedStages, timeline, browserCorpus: failed_report_summary(latestReport), error: { name: cause.name, message: cause.message, stack: cause.stack } });
    throw new DeploymentCaptureFailure(candidate, stage, cause);
  } finally {
    try {
      stage = "cleanup-client-close";
      adapter?.dispose();
      runtime?.dispose();
      if (server) {
        const clientSockets = await wait_for_client_close(server);
        stage = "cleanup-server-stop";
        await server.stop();
        const browser = server.browserMetrics?.();
        if (browser) {
          assert.equal(browser.activeProcesses, 0);
          assert.equal(browser.activeJourneys, 0);
          assert.equal(browser.retainedArtifactRoots, 0);
        }
        cleanup = { captureId, clientSockets, browser };
      }
      process.chdir(cwd);
      stage = "cleanup-repository-state";
      if (before !== undefined) {
        assert.deepEqual(await state(stateSupervisor), before);
        sourceRevalidated = true;
      }
      stage = "cleanup-persistence";
      atomic_sync(join(capture, "capture-cleanup.json"), cleanup);
      cleanupPersisted = true;
    } catch (error) {
      cleanupFailure = error;
      throw error;
    } finally {
      const stateChildrenBeforeDispose = stateSupervisor.metrics().activeChildren;
      let stateSettlementFailure: unknown;
      try { await dispose_capture_state_supervisor(stateSupervisor); }
      catch (error) { stateSettlementFailure = error; }
      const stateChildren = stateSupervisor.metrics().activeChildren;
      process.chdir(cwd);
      const terminal = Object.freeze({
        schemaVersion: 1,
        kind: "hson-deployment-capture-terminal",
        captureId,
        status: captureFailure === undefined && cleanupFailure === undefined && stateSettlementFailure === undefined && stateChildrenBeforeDispose === 0 && stateChildren === 0 && sourceRevalidated ? "passed" : "failed",
        completedAt: new Date().toISOString(),
        lastCheckpoint: cleanupPersisted ? "cleanup-persisted" : stage,
        selectedStages: requestedStages ?? Object.keys(selection ?? {}),
        deployment: before ?? null,
        sourceRevalidated,
        externalOwnership: Object.freeze({
          stateChildren,
          clientSockets: (cleanup.clientSockets as { total: number }).total,
          browserProcesses: (cleanup.browser as { activeProcesses?: number }).activeProcesses,
          browserJourneys: (cleanup.browser as { activeJourneys?: number }).activeJourneys,
        }),
        activeResourcesBeforeCommandExit: process.getActiveResourcesInfo(),
      });
      try {
        persist_capture_terminal(join(capture, "capture-terminal.json"), terminal);
        trace_internal_cli("capture-terminal-written");
      } catch (terminalWriteError) {
        if (captureFailure === undefined && cleanupFailure === undefined) throw terminalWriteError;
      }
      if (stateSettlementFailure !== undefined) throw stateSettlementFailure;
      if (stateChildrenBeforeDispose !== 0 && captureFailure === undefined && cleanupFailure === undefined) {
        throw new Error(`DEPLOYMENT_CAPTURE_STATE_CHILDREN_REMAIN:${stateChildrenBeforeDispose}`);
      }
    }
  }
  trace_internal_cli("finally-complete");
  return candidate;
}

type DeploymentCaptureCommandDependencies = Readonly<{
  capture?: typeof capture_deployment_tests;
  captureOptions?: Omit<DeploymentCaptureOptions, "stages">;
  writeOutput?: (fd: 1 | 2, value: string) => void;
  checkpoint?: (checkpoint: DeploymentCaptureCommandCheckpoint) => void;
}>;

type DeploymentCaptureCommandCheckpointName =
  | "terminal-file-written"
  | "capture-function-resolved"
  | "capture-function-rejected"
  | "final-result-emission-begins"
  | "final-result-emission-completes"
  | "command-result-resolved";
type DeploymentCaptureCommandCheckpoint = Readonly<{
  name: DeploymentCaptureCommandCheckpointName;
  activeResources: readonly string[];
}>;

const DEPLOYMENT_CAPTURE_COMMAND_DEPENDENCIES = Symbol.for("terminal-gothic-deploy.capture-command-dependencies");

function injected_command_dependencies(): Pick<DeploymentCaptureCommandDependencies, "capture" | "captureOptions" | "checkpoint"> {
  return (globalThis as typeof globalThis & { [DEPLOYMENT_CAPTURE_COMMAND_DEPENDENCIES]?: Pick<DeploymentCaptureCommandDependencies, "capture" | "captureOptions" | "checkpoint"> })[DEPLOYMENT_CAPTURE_COMMAND_DEPENDENCIES] ?? {};
}

function record_command_checkpoint(name: DeploymentCaptureCommandCheckpointName, checkpoint?: DeploymentCaptureCommandDependencies["checkpoint"]): void {
  checkpoint?.(Object.freeze({ name, activeResources: Object.freeze(process.getActiveResourcesInfo()) }));
}

export function is_deployment_capture_main(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (argvEntry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(argvEntry));
  } catch {
    return false;
  }
}

function bounded_terminal_output(value: string): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= DEPLOYMENT_CAPTURE_TERMINAL_OUTPUT_LIMIT_BYTES) return value;
  const marker = Buffer.from(DEPLOYMENT_CAPTURE_TERMINAL_TRUNCATION);
  const retained = bytes.subarray(0, DEPLOYMENT_CAPTURE_TERMINAL_OUTPUT_LIMIT_BYTES - marker.byteLength);
  return Buffer.concat([retained, marker]).toString("utf8");
}

function bounded_capture_failure_cause(value: string): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= DEPLOYMENT_CAPTURE_CAUSE_OUTPUT_LIMIT_BYTES) return value;
  const marker = Buffer.from(DEPLOYMENT_CAPTURE_CAUSE_TRUNCATION);
  const retained = bytes.subarray(0, DEPLOYMENT_CAPTURE_CAUSE_OUTPUT_LIMIT_BYTES - marker.byteLength);
  return Buffer.concat([retained, marker]).toString("utf8");
}

export function write_terminal_output(fd: 1 | 2, value: string): void {
  const bytes = Buffer.from(bounded_terminal_output(value));
  try {
    // Terminal output is operator convenience, not evidence or completion
    // authority. One bounded attempt prevents backpressure from delaying the
    // already-durable capture result or replacing it with EAGAIN.
    writeSync(fd, bytes, 0, bytes.byteLength);
  } catch {
    // The supervisor and retained capture remain authoritative.
  }
}

export function format_deployment_capture_failure(
  error: unknown,
  certification: boolean,
): string {
  const cause = error instanceof Error ? error : new Error(String(error));
  const candidate = cause instanceof DeploymentCaptureFailure
    ? cause.candidate
    : process.env.HSON_CERTIFICATION_CAPTURE_CANDIDATE;
  const failingSuiteIds = cause instanceof DeploymentCaptureFailure
    ? cause.failingSuiteIds
    : failing_suite_ids_from_error(cause);
  const lines = [certification ? "CERTIFICATION FAILED" : "DEPLOYMENT CAPTURE FAILED", ""];
  if (failingSuiteIds.length > 0) {
    lines.push(`Failed suites: ${failingSuiteIds.length}`);
    lines.push(...failingSuiteIds.map((id) => `- ${id}`));
    lines.push("");
  }
  if (cause instanceof DeploymentCaptureFailure && cause.failedStage === "preflight-state") {
    lines.push(`Failure: ${bounded_capture_failure_cause(cause.message)}`);
    lines.push("");
  }
  if (candidate !== undefined) {
    lines.push("Retained diagnostics:");
    lines.push(join(candidate, "capture-diagnostics.json"));
  } else if (failingSuiteIds.length > 0) {
    lines.push("Retained diagnostics: unavailable");
  } else {
    lines.push(`Failure: ${cause.message.split("\n", 1)[0] ?? cause.name}`);
  }
  return bounded_terminal_output(`${lines.join("\n")}\n`);
}

export async function run_deployment_capture_command(
  arguments_: readonly string[],
  dependencies: DeploymentCaptureCommandDependencies = {},
): Promise<0 | 1> {
  const injectedDependencies = injected_command_dependencies();
  const captureCommand = dependencies.capture ?? injectedDependencies.capture ?? capture_deployment_tests;
  const captureOptions = dependencies.captureOptions ?? injectedDependencies.captureOptions ?? {};
  const writeOutput = dependencies.writeOutput ?? write_terminal_output;
  const checkpoint = dependencies.checkpoint ?? injectedDependencies.checkpoint;
  const certification = arguments_.includes("--certification-only")
    || arguments_.includes("--stage=certification");
  try {
    const stages = parse_capture_stages(arguments_);
    const candidate = await captureCommand({ ...captureOptions, ...(stages === undefined ? {} : { stages }) });
    trace_internal_cli("capture-function-resolved");
    record_command_checkpoint("capture-function-resolved", checkpoint);
    trace_internal_cli("run-command-resolved");
    trace_internal_cli("final-output-begin");
    record_command_checkpoint("final-result-emission-begins", checkpoint);
    try { writeOutput(1, bounded_terminal_output(`${candidate}\n`)); } catch { /* non-authoritative terminal */ }
    trace_internal_cli("final-output-complete");
    record_command_checkpoint("final-result-emission-completes", checkpoint);
    return 0;
  } catch (error) {
    record_command_checkpoint("capture-function-rejected", checkpoint);
    const cause = error instanceof Error ? error : new Error(String(error));
    trace_internal_cli("run-command-resolved");
    trace_internal_cli("final-output-begin");
    record_command_checkpoint("final-result-emission-begins", checkpoint);
    try { writeOutput(2, format_deployment_capture_failure(cause, certification)); } catch { /* non-authoritative terminal */ }
    trace_internal_cli("final-output-complete");
    record_command_checkpoint("final-result-emission-completes", checkpoint);
    return 1;
  }
}

if (is_deployment_capture_main(import.meta.url, process.argv[1])) {
  process.exitCode = await run_deployment_capture_command(process.argv.slice(2));
  trace_internal_cli("main-result-received");
  record_command_checkpoint("command-result-resolved", injected_command_dependencies().checkpoint);
}
