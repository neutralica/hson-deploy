import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
    const terminal = JSON.parse(await readFile(join(candidate, "capture", "capture-terminal.json"), "utf8"));
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.externalOwnership.stateChildren, 0);
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

test("production npm/tsx first preflight Git child is reaped and leaves a diagnosable failed candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "deployment-capture-production-preflight-"));
  const bin = join(root, "bin");
  const marker = join(root, "git-child.json");
  const preloadUrl = pathToFileURL(resolve(import.meta.dirname, "fixtures/capture-cli-command-preload.mjs")).href;
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(process.env.CAPTURE_FAKE_GIT_MARKER,JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));process.stderr.write("intentional preflight failure\\n");process.exit(7);\n`);
  await chmod(join(bin, "git"), 0o755);
  const before = new Set(await readdir(DEPLOYMENT_WORK));
  const child = spawn("npm", ["run", "capture:deployment-tests:certification"], {
    cwd: DEPLOYMENT_ROOT,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preloadUrl}`].filter(Boolean).join(" "),
      DEPLOYMENT_CAPTURE_CLI_PREFLIGHT_TIMER_ONLY: "1",
      CAPTURE_FAKE_GIT_MARKER: marker,
      UV_THREADPOOL_SIZE: "1",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  try {
    const [code, signal] = await with_watchdog(once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>, 5_000);
    assert.equal(signal, null);
    assert.equal(code, 1);
    assert.match(stdout, /> \.\/node_modules\/\.bin\/tsx scripts\/capture-deployment-tests\.mts --certification-only\n/);
    assert.match(stderr, /DEPLOYMENT_CAPTURE_STATE_COMMAND_FAILED:git status --porcelain[\s\S]*intentional preflight failure/);
    const direct = JSON.parse(await readFile(marker, "utf8")) as { pid: number; args: string[] };
    assert.deepEqual(direct.args, ["status", "--porcelain"]);
    await wait_for_process_absence(direct.pid);
    const additions = (await readdir(DEPLOYMENT_WORK)).filter((entry) => entry.startsWith("capture-") && !before.has(entry));
    assert.equal(additions.length, 1, "the failed production preflight must retain exactly one candidate");
    const candidate = join(DEPLOYMENT_WORK, additions[0]!);
    const preflight = JSON.parse(await readFile(join(candidate, "capture-preflight.json"), "utf8"));
    assert.equal(preflight.status, "failed");
    assert.equal(preflight.stage, "preflight-state");
    const diagnostics = JSON.parse(await readFile(join(candidate, "capture-diagnostics.json"), "utf8"));
    assert.equal(diagnostics.failedStage, "preflight-state");
    const terminal = JSON.parse(await readFile(join(candidate, "capture", "capture-terminal.json"), "utf8"));
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.externalOwnership.stateChildren, 0);
    await rm(candidate, { recursive: true, force: true });
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      try { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("focused certification reaches terminal capture finalization after all owned execution settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "deployment-capture-orchestration-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!${process.execPath}\nconst args=process.argv.slice(2);if(args[0]==="ls-tree")process.stdout.write("160000 commit capture-fixture\\t"+(args[2]??"")+"\\n");else if(args[0]==="rev-parse")process.stdout.write("capture-fixture\\n");\n`);
  await chmod(join(bin, "git"), 0o755);
  const priorPath = process.env.PATH;
  let candidate: string | undefined;
  try {
    process.env.PATH = `${bin}${delimiter}${priorPath ?? ""}`;
    candidate = await with_watchdog(capture_deployment_tests({
      stages: ["certification"],
      selectionOverrides: { certification: ["verification/demo/test-node-process-supervisor"] },
    }), 30_000);
    const report = JSON.parse(await readFile(join(candidate, "capture", "certification.json"), "utf8"));
    assert.equal(report.run.status, "passed");
    assert.deepEqual(report.plan.selectionIds, ["verification/demo/test-node-process-supervisor"]);
    assert.equal(report.suiteRuns[0]?.status, "pass");
    const cleanup = JSON.parse(await readFile(join(candidate, "capture", "capture-cleanup.json"), "utf8"));
    assert.equal(cleanup.clientSockets.total, 0);
    assert.equal(cleanup.browser.activeProcesses, 0);
    assert.equal(cleanup.browser.activeJourneys, 0);
    const terminal = JSON.parse(await readFile(join(candidate, "capture", "capture-terminal.json"), "utf8"));
    assert.equal(terminal.status, "passed");
    assert.equal(terminal.lastCheckpoint, "cleanup-persisted");
    assert.deepEqual(terminal.externalOwnership, {
      stateChildren: 0,
      clientSockets: 0,
      browserProcesses: 0,
      browserJourneys: 0,
    });
  } finally {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (candidate !== undefined) await rm(candidate, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("production npm/tsx capture CLI persists, emits, and exits pass and fail outcomes despite a referenced handle", async () => {
  const preloadUrl = pathToFileURL(resolve(import.meta.dirname, "fixtures/capture-cli-command-preload.mjs")).href;
  const root = await mkdtemp(join(tmpdir(), "deployment-capture-cli-terminal-"));
  try {
    for (const fixture of [{ status: "passed", exitCode: 0 }, { status: "failed", exitCode: 1 }]) {
      const candidate = join(root, fixture.status);
      const terminalPath = join(candidate, "capture", "capture-terminal.json");
      const tracePath = join(root, `${fixture.status}-checkpoints.jsonl`);
      const child = spawn("npm", ["run", "capture:deployment-tests:certification"], {
        cwd: DEPLOYMENT_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preloadUrl}`].filter(Boolean).join(" "),
          DEPLOYMENT_CAPTURE_CLI_FIXTURE_CANDIDATE: candidate,
          DEPLOYMENT_CAPTURE_CLI_FIXTURE_STATUS: fixture.status,
          DEPLOYMENT_CAPTURE_CLI_FIXTURE_TRACE: tracePath,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      const [code, signal] = await with_watchdog(once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>, 5_000);
      assert.deepEqual(JSON.parse(await readFile(terminalPath, "utf8")), { status: fixture.status, lastCheckpoint: "fixture-terminal-persisted" }, "terminal record must exist before command completion");
      const checkpoints = (await readFile(tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { name: string; activeResources: string[] });
      assert.deepEqual(checkpoints.map(({ name }) => name), [
        "terminal-file-written",
        fixture.status === "passed" ? "capture-function-resolved" : "capture-function-rejected",
        "command-result-resolved",
        "final-result-emission-begins",
        "final-result-emission-completes",
        "process-exit-reached",
      ]);
      assert.ok(checkpoints.every(({ activeResources }) => Array.isArray(activeResources)), "every boundary must snapshot active resource types");
      assert.equal(checkpoints.some(({ activeResources }) => activeResources.includes("FSReqPromise")), false, "the production-shaped terminal path must not manufacture asynchronous filesystem settlement");
      assert.match(stdout, /> \.\/node_modules\/\.bin\/tsx scripts\/capture-deployment-tests\.mts --certification-only\n/, "npm must launch the production tsx command");
      assert.equal(signal, null);
      assert.equal(code, fixture.exitCode);
      if (fixture.status === "failed") {
        assert.doesNotMatch(stdout, new RegExp(`${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
        assert.match(stderr, /Error: DEPLOYMENT_CAPTURE_CLI_FIXTURE_FAILURE[\s\S]*\n/);
      } else {
        assert.match(stdout, new RegExp(`${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
        assert.equal(stderr, "");
      }
      assert.ok(child.pid !== undefined);
      await wait_for_process_absence(child.pid);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production npm/tsx certification exits after a real validation failure", async () => {
  const preloadUrl = pathToFileURL(resolve(import.meta.dirname, "fixtures/capture-cli-command-preload.mjs")).href;
  const root = await mkdtemp(join(tmpdir(), "deployment-capture-cli-real-validation-"));
  const bin = join(root, "bin");
  const tracePath = join(root, "checkpoints.jsonl");
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!${process.execPath}\nconst args=process.argv.slice(2);if(args[0]==="ls-tree")process.stdout.write("160000 commit capture-fixture\\t"+(args[2]??"")+"\\n");else if(args[0]==="rev-parse")process.stdout.write("capture-fixture\\n");\n`);
  await chmod(join(bin, "git"), 0o755);
  const before = new Set(await readdir(DEPLOYMENT_WORK));
  const child = spawn("npm", ["run", "capture:deployment-tests:certification"], {
    cwd: DEPLOYMENT_ROOT,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preloadUrl}`].filter(Boolean).join(" "),
      DEPLOYMENT_CAPTURE_CLI_REAL_VALIDATION_FAILURE: "1",
      DEPLOYMENT_CAPTURE_CLI_FIXTURE_TRACE: tracePath,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  let candidate: string | undefined;
  try {
    const [code, signal] = await with_watchdog(once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>, 45_000);
    assert.equal(signal, null);
    assert.equal(code, 1);
    assert.match(stdout, /> \.\/node_modules\/\.bin\/tsx scripts\/capture-deployment-tests\.mts --certification-only\n/);
    assert.match(stderr, /Expected values to be strictly deep-equal/);
    assert.match(stderr, /verification\/demo\/test-presentation-cleanup-node/);
    assert.doesNotMatch(stdout, /\.deployment-work\/capture-[^\n]+\n/);
    const additions = (await readdir(DEPLOYMENT_WORK)).filter((entry) => entry.startsWith("capture-") && !before.has(entry));
    assert.equal(additions.length, 1, "the real validation failure must retain exactly one capture candidate");
    candidate = join(DEPLOYMENT_WORK, additions[0]!);
    const diagnostics = JSON.parse(await readFile(join(candidate, "capture-diagnostics.json"), "utf8"));
    assert.equal(diagnostics.failedStage, "certification:validation");
    const cleanup = JSON.parse(await readFile(join(candidate, "capture", "capture-cleanup.json"), "utf8"));
    assert.equal(cleanup.clientSockets.total, 0);
    const terminal = JSON.parse(await readFile(join(candidate, "capture", "capture-terminal.json"), "utf8"));
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.lastCheckpoint, "cleanup-persisted");
    const checkpoints = (await readFile(tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { name: string; activeResources: string[] });
    assert.deepEqual(checkpoints.map(({ name }) => name), [
      "terminal-file-written",
      "capture-function-rejected",
      "command-result-resolved",
      "final-result-emission-begins",
      "final-result-emission-completes",
      "process-exit-reached",
    ]);
    assert.ok(checkpoints.every(({ activeResources }) => Array.isArray(activeResources)));
    assert.equal(checkpoints[0]!.activeResources.includes("FSReqPromise"), false, "terminal persistence must not run inside an async filesystem completion");
    assert.ok(child.pid !== undefined);
    await wait_for_process_absence(child.pid);
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      try { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
    }
    if (candidate !== undefined) await rm(candidate, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
