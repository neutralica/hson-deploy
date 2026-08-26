import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { create_node_process_supervisor, type NodeProcessExecution, type NodeProcessResult, type NodeProcessSupervisor } from "../hson-demo2/tests/harness/runtimes/node/node-process-supervisor";
import { assert_exact_selected_results } from "./test-evidence/selection-accounting.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const TERMINAL_POLL_MS = 25;
const NATURAL_EXIT_GRACE_MS = 50;
const PROCESS_SETTLEMENT_GRACE_MS = 1_000;
const SOURCE_COMMAND_TIMEOUT_MS = 30_000;
// The imported process supervisor requires a timer. This is the Node timer
// ceiling, not certification authority: terminal appearance or premature child
// exit is the completion event under ordinary operation.
const EFFECTIVELY_UNBOUNDED_CAPTURE_MS = 2_147_483_647;

type JsonRecord = Record<string, any>;
type DeploymentState = Readonly<{
  hsonDeployCommit: string;
  hsonDemo2Gitlink: string;
  hsonLiveGitlink: string;
  intrastructureGitlink: string;
}>;
export type ValidatedCertificationTerminal = Readonly<{
  candidate: string;
  captureId: string;
  status: "passed" | "failed";
  deployment: DeploymentState | null;
}>;

type ExecutionOwner = Readonly<{
  execution: NodeProcessExecution;
  metrics(): Readonly<{ activeChildren: number }>;
  dispose(): void;
}>;

export type CertificationSupervisorOptions = Readonly<{
  deploymentRoot?: string;
  captureId?: string;
  candidate?: string;
  command?: string;
  args?: readonly string[];
  environment?: Readonly<Record<string, string>>;
  naturalExitGraceMs?: number;
  pollMs?: number;
  launch?: (invocation: Readonly<{ cwd: string; command: string; args: readonly string[]; environment: Readonly<Record<string, string>> }>) => ExecutionOwner;
  readSourceState?: (deploymentRoot: string) => Promise<DeploymentState>;
}>;

function json(path: string, label: string): JsonRecord {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`CERTIFICATION_${label}_INVALID:${path}`); }
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `CERTIFICATION_${label}_INVALID:${path}`);
  return value as JsonRecord;
}

function same_json(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validate_cleanup(cleanup: JsonRecord, captureId: string): void {
  assert.equal(cleanup.captureId, captureId, "CERTIFICATION_CLEANUP_CAPTURE_MISMATCH");
  assert.equal(cleanup.clientSockets?.total, 0, "CERTIFICATION_CLEANUP_CLIENT_SOCKETS_REMAIN");
  assert.equal(cleanup.clientSockets?.hostedTests?.total, 0, "CERTIFICATION_CLEANUP_HOSTED_SOCKETS_REMAIN");
  assert.equal(cleanup.clientSockets?.towl, 0, "CERTIFICATION_CLEANUP_TOWL_SOCKETS_REMAIN");
  assert.equal(cleanup.clientSockets?.circuitVerification, 0, "CERTIFICATION_CLEANUP_CIRCUIT_SOCKETS_REMAIN");
  assert.equal(cleanup.browser?.activeProcesses, 0, "CERTIFICATION_CLEANUP_BROWSER_PROCESSES_REMAIN");
  assert.equal(cleanup.browser?.activeJourneys, 0, "CERTIFICATION_CLEANUP_BROWSER_JOURNEYS_REMAIN");
  assert.equal(cleanup.browser?.retainedArtifactRoots, 0, "CERTIFICATION_CLEANUP_ARTIFACT_ROOTS_REMAIN");
}

function validate_evidence(report: JsonRecord): void {
  for (const suite of report.suiteRuns as JsonRecord[]) {
    const evidence = suite.evidence as JsonRecord[];
    const ids = new Set(evidence.map((entry) => entry.id));
    assert.equal(ids.size, evidence.length, `CERTIFICATION_REPORT_DUPLICATE_EVIDENCE:${suite.id}`);
    const referenced = new Set([
      ...(suite.evidenceRefs as string[]),
      ...(suite.cases as JsonRecord[]).flatMap((test) => test.evidenceRefs as string[]),
    ]);
    for (const id of referenced) {
      assert.ok(ids.has(id), `CERTIFICATION_REPORT_EVIDENCE_MISSING:${suite.id}:${id}`);
      const entry = evidence.find((candidate) => candidate.id === id)!;
      assert.ok(entry.content.length > 0 || entry.reference === null, `CERTIFICATION_REPORT_TRANSIENT_EVIDENCE:${suite.id}:${id}`);
    }
  }
}

function validate_pass_artifacts(candidate: string, captureId: string, terminal: JsonRecord, cleanup: JsonRecord): DeploymentState {
  const capture = join(candidate, "capture");
  const preflight = json(join(candidate, "capture-preflight.json"), "PREFLIGHT");
  const metadata = json(join(capture, "capture-metadata.json"), "METADATA");
  const reportPath = join(capture, "certification.json");
  const reportBytes = readFileSync(reportPath);
  let report: JsonRecord;
  try { report = JSON.parse(reportBytes.toString("utf8")); }
  catch { throw new Error(`CERTIFICATION_REPORT_INVALID:${reportPath}`); }

  assert.equal(preflight.captureId, captureId, "CERTIFICATION_PREFLIGHT_CAPTURE_MISMATCH");
  assert.equal(preflight.status, "passed", "CERTIFICATION_PREFLIGHT_NOT_PASSED");
  assert.equal(metadata.captureId, captureId, "CERTIFICATION_METADATA_CAPTURE_MISMATCH");
  assert.deepEqual(metadata.selectedStages, ["certification"], "CERTIFICATION_STAGE_MISMATCH");
  assert.equal(terminal.sourceRevalidated, true, "CERTIFICATION_SOURCE_NOT_REVALIDATED");
  assert.ok(terminal.deployment !== null, "CERTIFICATION_SOURCE_IDENTITY_MISSING");
  assert.ok(same_json(preflight.deployment, terminal.deployment), "CERTIFICATION_PREFLIGHT_SOURCE_MISMATCH");
  assert.ok(same_json(metadata.deployment, terminal.deployment), "CERTIFICATION_METADATA_SOURCE_MISMATCH");

  const selection = metadata.selection?.certification;
  const run = metadata.runs?.certification;
  assert.ok(selection && run, "CERTIFICATION_METADATA_AUTHORITY_INCOMPLETE");
  assert.ok(Array.isArray(selection.ids) && selection.ids.length > 0, "CERTIFICATION_SELECTION_EMPTY");
  assert.equal(new Set(selection.ids).size, selection.ids.length, "CERTIFICATION_SELECTION_DUPLICATE");
  assert.equal(selection.idCount, selection.ids.length, "CERTIFICATION_SELECTION_COUNT_MISMATCH");
  assert.equal(run.reportFile, "certification.json", "CERTIFICATION_REPORT_FILE_MISMATCH");
  assert.equal(run.selectionCount, selection.ids.length, "CERTIFICATION_RUN_SELECTION_COUNT_MISMATCH");
  assert.equal(run.rawBytes, reportBytes.byteLength, "CERTIFICATION_REPORT_BYTES_MISMATCH");
  assert.equal(run.runId, report.run?.id, "CERTIFICATION_RUN_ID_MISMATCH");
  assert.equal(Number.isInteger(run.reportRev) && run.reportRev >= 0, true, "CERTIFICATION_REPORT_REVISION_INVALID");
  assert.equal(run.reportRev, run.clientAppliedReportRev, "CERTIFICATION_REPORT_REVISION_UNRECONCILED");
  assert.equal(run.terminalStatus, "passed", "CERTIFICATION_RUN_NOT_PASSED");
  assert.equal(report.run?.status, "passed", "CERTIFICATION_REPORT_NOT_PASSED");
  assert.equal(report.error, null, "CERTIFICATION_REPORT_ERROR_RETAINED");
  assert.ok(Array.isArray(report.plan?.selectionIds), "CERTIFICATION_REPORT_SELECTION_INVALID");
  assert.equal(new Set(report.plan.selectionIds).size, report.plan.selectionIds.length, "CERTIFICATION_REPORT_SELECTION_DUPLICATE");
  assert.deepEqual([...report.plan.selectionIds].sort(), [...selection.ids].sort(), "CERTIFICATION_REPORT_SELECTION_MISMATCH");
  assert.ok(Array.isArray(report.suiteRuns), "CERTIFICATION_REPORT_RESULTS_INVALID");
  assert_exact_selected_results(selection.ids, report.suiteRuns, "certification-parent");
  assert.equal(report.summary?.fail, 0, "CERTIFICATION_REPORT_FAILURES_RETAINED");
  assert.equal(report.summary?.skip, 0, "CERTIFICATION_REPORT_SKIPS_RETAINED");
  assert.equal(report.suiteRuns.every((suite: JsonRecord) => suite.status === "pass"), true, "CERTIFICATION_RESULT_NOT_PASSED");
  assert.equal(report.suiteRuns.every((suite: JsonRecord) => suite.executionShape === "certification-aggregate"), true, "CERTIFICATION_RESULT_SHAPE_INVALID");
  assert.equal(report.suiteRuns.every((suite: JsonRecord) => suite.sourceRef?.startsWith("node-command:") && !suite.id.includes("generated-json")), true, "CERTIFICATION_RESULT_SOURCE_INVALID");
  validate_evidence(report);
  validate_cleanup(cleanup, captureId);
  return terminal.deployment as DeploymentState;
}

export function validate_certification_terminal(candidateInput: string, captureId: string): ValidatedCertificationTerminal {
  const candidate = resolve(candidateInput);
  const capture = join(candidate, "capture");
  const terminal = json(join(capture, "capture-terminal.json"), "TERMINAL");
  const cleanup = json(join(capture, "capture-cleanup.json"), "CLEANUP");
  assert.equal(terminal.schemaVersion, 1, "CERTIFICATION_TERMINAL_SCHEMA_INVALID");
  assert.equal(terminal.kind, "hson-deployment-capture-terminal", "CERTIFICATION_TERMINAL_KIND_INVALID");
  assert.equal(terminal.captureId, captureId, "CERTIFICATION_TERMINAL_CAPTURE_MISMATCH");
  assert.deepEqual(terminal.selectedStages, ["certification"], "CERTIFICATION_TERMINAL_STAGE_MISMATCH");
  assert.ok(terminal.status === "passed" || terminal.status === "failed", "CERTIFICATION_TERMINAL_STATUS_INVALID");
  assert.deepEqual(terminal.externalOwnership, {
    stateChildren: 0,
    clientSockets: 0,
    browserProcesses: 0,
    browserJourneys: 0,
  }, "CERTIFICATION_TERMINAL_OWNERSHIP_REMAINS");
  validate_cleanup(cleanup, captureId);

  let deployment: DeploymentState | null = terminal.deployment ?? null;
  if (terminal.status === "passed") {
    deployment = validate_pass_artifacts(candidate, captureId, terminal, cleanup);
  } else {
    const diagnostics = json(join(candidate, "capture-diagnostics.json"), "DIAGNOSTICS");
    const preflight = json(join(candidate, "capture-preflight.json"), "PREFLIGHT");
    assert.equal(diagnostics.captureId, captureId, "CERTIFICATION_DIAGNOSTICS_CAPTURE_MISMATCH");
    assert.equal(preflight.captureId, captureId, "CERTIFICATION_PREFLIGHT_CAPTURE_MISMATCH");
    if (deployment === null) {
      assert.equal(preflight.status, "failed", "CERTIFICATION_FAILED_SOURCE_IDENTITY_MISSING");
    } else {
      assert.ok(same_json(preflight.deployment, deployment), "CERTIFICATION_FAILED_SOURCE_MISMATCH");
    }
  }
  return Object.freeze({ candidate, captureId, status: terminal.status, deployment });
}

function create_execution_owner(invocation: Readonly<{ cwd: string; command: string; args: readonly string[]; environment: Readonly<Record<string, string>> }>): ExecutionOwner {
  const supervisor = create_node_process_supervisor({
    stdoutLimitBytes: 64 * 1024 * 1024,
    stderrLimitBytes: 16 * 1024 * 1024,
    truncationMarker: "<CERTIFICATION_CAPTURE_OUTPUT_TRUNCATED>",
    terminationGraceMs: PROCESS_SETTLEMENT_GRACE_MS,
  });
  const execution = supervisor.start({ ...invocation, timeoutMs: EFFECTIVELY_UNBOUNDED_CAPTURE_MS });
  return Object.freeze({ execution, metrics: () => supervisor.metrics(), dispose: () => supervisor.dispose() });
}

async function run_git(supervisor: NodeProcessSupervisor, root: string, args: readonly string[], cwd = root): Promise<string> {
  const result = await supervisor.start({ cwd, command: "git", args, environment: {}, timeoutMs: SOURCE_COMMAND_TIMEOUT_MS }).result;
  if (!result.ok) throw new Error(`CERTIFICATION_SOURCE_COMMAND_FAILED:git ${args.join(" ")}:${result.spawnError ?? result.stderr}`);
  return result.stdout.trim();
}

async function read_deployment_state(root: string): Promise<DeploymentState> {
  const supervisor = create_node_process_supervisor({ stdoutLimitBytes: 1024 * 1024, stderrLimitBytes: 1024 * 1024, truncationMarker: "<CERTIFICATION_SOURCE_OUTPUT_TRUNCATED>", terminationGraceMs: 1_000 });
  try {
    if (await run_git(supervisor, root, ["status", "--porcelain"]) !== "") throw new Error("CERTIFICATION_SOURCE_PARENT_DIRTY");
    const links: Record<string, string> = {};
    for (const path of ["hson-demo2", "hson-live", "intrastructure"]) {
      const expected = (await run_git(supervisor, root, ["ls-tree", "HEAD", path])).split(/\s+/)[2];
      const actual = await run_git(supervisor, root, ["rev-parse", "HEAD"], join(root, path));
      if (expected !== actual || await run_git(supervisor, root, ["status", "--porcelain"], join(root, path)) !== "") throw new Error(`CERTIFICATION_SOURCE_SUBMODULE_INVALID:${path}`);
      links[path] = actual;
    }
    return Object.freeze({ hsonDeployCommit: await run_git(supervisor, root, ["rev-parse", "HEAD"]), hsonDemo2Gitlink: links["hson-demo2"]!, hsonLiveGitlink: links["hson-live"]!, intrastructureGitlink: links.intrastructure! });
  } finally {
    supervisor.dispose();
  }
}

async function observe_terminal(candidate: string, captureId: string, pollMs: number, signal: AbortSignal): Promise<ValidatedCertificationTerminal> {
  const terminalPath = join(candidate, "capture", "capture-terminal.json");
  while (!signal.aborted) {
    try {
      await access(terminalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw terminal_invalid(error);
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, pollMs);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolveWait(); }, { once: true });
      });
      continue;
    }
    try {
      return validate_certification_terminal(candidate, captureId);
    } catch (error) {
      throw terminal_invalid(error);
    }
  }
  throw new Error("CERTIFICATION_TERMINAL_OBSERVATION_CANCELLED");
}

function validate_process_settlement(result: NodeProcessResult, owner: ExecutionOwner): void {
  if (result.spawnError !== undefined) throw new Error(`CERTIFICATION_CAPTURE_SETTLEMENT_FAILED:${result.spawnError}`);
  if (owner.metrics().activeChildren !== 0) throw new Error(`CERTIFICATION_CAPTURE_PROCESS_REMAINS:${owner.metrics().activeChildren}`);
}

function terminal_invalid(cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`CERTIFICATION_CAPTURE_TERMINAL_INVALID:${detail}`, { cause });
}

export async function supervise_certification_capture(options: CertificationSupervisorOptions = {}): Promise<ValidatedCertificationTerminal & Readonly<{ process: NodeProcessResult }>> {
  const deploymentRoot = resolve(options.deploymentRoot ?? ROOT);
  const workRoot = join(deploymentRoot, ".deployment-work");
  const captureId = options.captureId ?? crypto.randomUUID();
  assert.match(captureId, /^[0-9a-f-]{36}$/i, "CERTIFICATION_CAPTURE_ID_INVALID");
  const candidate = resolve(options.candidate ?? join(workRoot, `capture-${Date.now().toString(36)}-${captureId}`));
  assert.equal(dirname(candidate), workRoot, "CERTIFICATION_CAPTURE_CANDIDATE_OUTSIDE_WORK_ROOT");
  assert.ok(basename(candidate).endsWith(captureId), "CERTIFICATION_CAPTURE_CANDIDATE_ID_MISMATCH");
  const invocation = Object.freeze({
    cwd: deploymentRoot,
    command: options.command ?? process.execPath,
    args: options.args ?? Object.freeze(["--import=tsx", "scripts/capture-deployment-tests.mts", "--certification-only"]),
    environment: Object.freeze({
      ...(options.environment ?? {}),
      HSON_CERTIFICATION_CAPTURE_ID: captureId,
      HSON_CERTIFICATION_CAPTURE_CANDIDATE: candidate,
    }),
  });
  const owner = (options.launch ?? create_execution_owner)(invocation);
  const observation = new AbortController();
  const terminalPromise = observe_terminal(candidate, captureId, options.pollMs ?? TERMINAL_POLL_MS, observation.signal);
  const childPromise = owner.execution.result;
  let terminal: ValidatedCertificationTerminal;
  let processResult: NodeProcessResult;
  try {
    const first = await Promise.race([
      terminalPromise.then((value) => Object.freeze({ kind: "terminal" as const, value })),
      childPromise.then((value) => Object.freeze({ kind: "child" as const, value })),
    ]);
    if (first.kind === "child") {
      observation.abort();
      processResult = first.value;
      validate_process_settlement(processResult, owner);
      try { terminal = validate_certification_terminal(candidate, captureId); }
      catch (cause) { throw terminal_invalid(cause); }
    } else {
      terminal = first.value;
      const natural = await Promise.race([
        childPromise.then((value) => Object.freeze({ settled: true as const, value })),
        new Promise<Readonly<{ settled: false }>>((resolveWait) => setTimeout(() => resolveWait(Object.freeze({ settled: false })), options.naturalExitGraceMs ?? NATURAL_EXIT_GRACE_MS)),
      ]);
      if (natural.settled) processResult = natural.value;
      else {
        owner.execution.terminate();
        processResult = await childPromise;
      }
      validate_process_settlement(processResult, owner);
    }
    if (terminal.deployment !== null) {
      const source = await (options.readSourceState ?? read_deployment_state)(deploymentRoot);
      assert.deepEqual(source, terminal.deployment, "CERTIFICATION_PARENT_SOURCE_IDENTITY_MISMATCH");
    } else if (terminal.status === "passed") {
      throw new Error("CERTIFICATION_PARENT_SOURCE_IDENTITY_MISSING");
    }
    return Object.freeze({ ...terminal, process: processResult });
  } catch (error) {
    owner.execution.terminate();
    const settlement = await childPromise;
    try { validate_process_settlement(settlement, owner); }
    catch (settlementError) { throw new AggregateError([error, settlementError], "CERTIFICATION_CAPTURE_FAILURE_AND_SETTLEMENT_FAILURE"); }
    throw error;
  } finally {
    observation.abort();
    owner.dispose();
  }
}

function is_main(moduleUrl: string, entry: string | undefined): boolean {
  return entry !== undefined && resolve(entry) === fileURLToPath(moduleUrl);
}

if (is_main(import.meta.url, process.argv[1])) {
  try {
    const result = await supervise_certification_capture();
    if (result.process.stderr) process.stderr.write(result.process.stderr);
    if (result.status === "passed") process.stdout.write(`${result.candidate}\n`);
    else {
      process.stderr.write(`CERTIFICATION_CAPTURE_FAILED:${result.candidate}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    process.stderr.write(`${cause.stack ?? cause.message}\n`);
    process.exitCode = 1;
  }
}
