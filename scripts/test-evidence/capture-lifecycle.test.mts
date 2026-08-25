import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { capture_deployment_selection, capture_deployment_tests } from "../capture-deployment-tests.mjs";
import { create_external_library_launcher_service } from "../../hson-demo2/tests/harness/runtimes/node/external-library-launchers";
import { run_node_selected_verifications } from "../../hson-demo2/tests/harness/runtimes/node/run-node-selected-verifications";

const DEPLOYMENT_ROOT = resolve(import.meta.dirname, "../..");
const DEPLOYMENT_WORK = join(DEPLOYMENT_ROOT, ".deployment-work");

function process_exists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function wait_for_process_absence(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (process_exists(pid) && Date.now() < deadline) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.equal(process_exists(pid), false, `process ${pid} must be reaped`);
}

async function with_watchdog<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("CAPTURE_LIFECYCLE_REGRESSION_DID_NOT_SETTLE")), milliseconds); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function certification_report(id: string, stdout: string) {
  const evidence = {
    id: `${id}:stdout`, sequence: 3, timestamp: 3, executorId: "fixture-node",
    kind: "stdout", name: "stdout", content: stdout, truncated: false,
    knownBytes: Buffer.byteLength(stdout), reference: null, mediaType: "text/plain",
  };
  return {
    run: { id: "capture-lifecycle-run", suite: "canonical/selected", status: "passed", startedAt: 1, completedAt: 4, timing: { runnerMs: 1, hostMs: 2 }, lastSequence: 4, lastEventSignature: "run_finished" },
    summary: { cases: 0, pass: 0, fail: 0, skip: 0 },
    plan: { protocolVersion: 1, catalogVersion: "capture-lifecycle", executorId: "fixture-node", selectionIds: [id] },
    suiteRuns: [{
      id, title: "Direct certification child", subject: "integration", collections: ["dev"], provenance: "hson-demo2", order: 0,
      executionShape: "certification-aggregate", plannedExecutorId: "fixture-node", sourceRef: "node-command:capture-lifecycle-direct-child", declaredChecks: 1,
      status: "pass", queuedAt: 1, startedAt: 2, completedAt: 3, durationMs: 1, ms: 1,
      counts: { declared: 1, total: 1, executed: 1, passed: 1, failed: 0, skipped: 0, unsupported: 0, cancelled: 0 },
      errors: [], evidence: [evidence], evidenceRefs: [evidence.id], caseOrder: [], runtime: "supervised-node-command", executorIds: ["fixture-node"], lastSequence: 3, lastEventSignature: "suite_end", cases: [],
    }],
    error: null,
  } as any;
}

test("certification child terminal state reaches capture persistence without retaining a launcher promise", async () => {
  const root = await mkdtemp(join(tmpdir(), "deployment-capture-lifecycle-"));
  const childPidFile = join(root, "certification-child.pid");
  const capture = join(root, "capture");
  await mkdir(capture);
  const id = "certification/direct-child-lifecycle";
  const target = Object.freeze({
    id,
    sourceCatalogId: "capture-lifecycle-direct-child",
    title: "Direct certification child",
    subject: "integration",
    provenance: "hson-demo2",
    sourceRef: "node-command:capture-lifecycle-direct-child",
    requirements: Object.freeze(["javascript", "node", "process"]),
    order: 0,
    cwd: root,
    command: process.execPath,
    args: Object.freeze(["-e", `require("node:fs").writeFileSync(${JSON.stringify(childPidFile)},String(process.pid));process.stdout.write("certification-child-terminal\\n")`]),
    environment: Object.freeze({}),
    timeoutMs: 5_000,
  });
  const descriptor = Object.freeze({
    id, title: target.title, subject: target.subject, collections: Object.freeze(["dev"]), provenance: target.provenance,
    order: 0, requirements: target.requirements, executionShape: "certification-aggregate", sourceRef: target.sourceRef, declaredChecks: 1,
  });
  const catalog = Object.freeze({ suites: Object.freeze([descriptor]), tests: Object.freeze([]) });
  const registry = Object.freeze({
    executor: Object.freeze({ id: "fixture-node", label: "fixture", runtime: "node", capabilities: Object.freeze({ provides: Object.freeze(["javascript", "node", "process"]) }) }),
    catalog: Object.freeze({ suites: Object.freeze([]), tests: Object.freeze([]) }), registrations: Object.freeze([]), get: () => undefined,
  });
  const launcherService = create_external_library_launcher_service();
  let report: ReturnType<typeof certification_report> | undefined;
  try {
    const adapter = {
      async start_selected(selectionIds: readonly string[]) {
        const result = await run_node_selected_verifications(
          registry as any,
          catalog as any,
          Object.freeze({ targets: Object.freeze([]), unavailable: Object.freeze([]) }) as any,
          selectionIds,
          () => undefined,
          {},
          {
            externalScheduling: Object.freeze({ kind: "fixed", concurrency: 1 }),
            launcherService,
            commandAvailability: Object.freeze({ targets: Object.freeze([target]), unavailable: Object.freeze([]) }) as any,
          },
        );
        assert.equal(result.ok, true, "certification scheduler must receive the child terminal result");
        assert.equal(result.summary.pass, 1);
        const stdout = "certification-child-terminal\n";
        report = certification_report(id, stdout);
        return Object.freeze({ ok: true, runId: report.run.id, attemptId: `${report.run.id}:attempt:1`, reportHostId: `host:${report.run.id}`, reportRev: 1, selectionIds: [...selectionIds] });
      },
      capture: () => report,
    };
    const captured = await with_watchdog(
      capture_deployment_selection(Object.freeze({ name: "certification", ids: Object.freeze([id]) }), capture, adapter),
      5_000,
    );
    const directPid = Number(await readFile(childPidFile, "utf8"));
    assert.ok(Number.isInteger(directPid) && directPid > 0);
    await wait_for_process_absence(directPid);
    assert.equal(launcherService.metrics().activeChildren, 0, "launcher service must release direct-child ownership");
    assert.equal(captured.run.terminalStatus, "passed");
    assert.equal(JSON.parse(await readFile(join(capture, "certification.json"), "utf8")).run.status, "passed");
  } finally {
    launcherService.terminate();
    await rm(root, { recursive: true, force: true });
  }
});

test("capture preflight bounds and diagnoses an exited direct state child with inherited stdio", async () => {
  const root = await mkdtemp(join(tmpdir(), "deployment-capture-preflight-"));
  const bin = join(root, "bin");
  const marker = join(root, "git-child.json");
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!${process.execPath}\nconst {spawn}=require("node:child_process");const {writeFileSync}=require("node:fs");const escaped=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:["ignore",process.stdout,"ignore"]});escaped.unref();writeFileSync(process.env.CAPTURE_FAKE_GIT_MARKER,JSON.stringify({directPid:process.pid,escapedPid:escaped.pid}));\n`);
  await chmod(join(bin, "git"), 0o755);
  const before = new Set(await readdir(DEPLOYMENT_WORK));
  const priorPath = process.env.PATH;
  const priorMarker = process.env.CAPTURE_FAKE_GIT_MARKER;
  let candidate: string | undefined;
  let escapedPid = 0;
  try {
    process.env.PATH = `${bin}${delimiter}${priorPath ?? ""}`;
    process.env.CAPTURE_FAKE_GIT_MARKER = marker;
    const startedAt = Date.now();
    await assert.rejects(
      capture_deployment_tests({ stages: ["certification"] }),
      /DEPLOYMENT_CAPTURE_STATE_COMMAND_FAILED:[\s\S]*PROCESS_STDIO_SETTLEMENT_FAILED/,
    );
    assert.ok(Date.now() - startedAt < 5_000, "capture preflight must explicitly fail instead of sleeping indefinitely");
    const ownership = JSON.parse(await readFile(marker, "utf8")) as { directPid: number; escapedPid: number };
    escapedPid = ownership.escapedPid;
    await wait_for_process_absence(ownership.directPid);
    const additions = (await readdir(DEPLOYMENT_WORK)).filter((entry) => entry.startsWith("capture-") && !before.has(entry));
    assert.equal(additions.length, 1, "failed preflight must retain one diagnosable capture candidate");
    candidate = join(DEPLOYMENT_WORK, additions[0]!);
    const diagnostics = JSON.parse(await readFile(join(candidate, "capture-diagnostics.json"), "utf8"));
    assert.equal(diagnostics.failedStage, "preflight-state");
    assert.match(diagnostics.error.message, /PROCESS_STDIO_SETTLEMENT_FAILED/);
  } finally {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (priorMarker === undefined) delete process.env.CAPTURE_FAKE_GIT_MARKER; else process.env.CAPTURE_FAKE_GIT_MARKER = priorMarker;
    if (escapedPid > 0) {
      try { process.kill(-escapedPid, "SIGKILL"); } catch { /* fixture already exited */ }
    }
    if (candidate !== undefined) await rm(candidate, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
