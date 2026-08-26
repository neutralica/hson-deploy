import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { supervise_certification_capture, validate_certification_terminal } from "../supervise-certification-capture.mjs";
import type { NodeProcessResult } from "../../hson-demo2/tests/harness/runtimes/node/node-process-supervisor";

const FIXTURE = resolve(import.meta.dirname, "fixtures/certification-completion-child.mjs");
const RETAINED_CAPTURE_ID = "c9d21536-f133-4f6d-8eda-9d7f456f780b";
const RETAINED_CANDIDATE = resolve(import.meta.dirname, `../../.deployment-work/capture-mt9nw2bm-${RETAINED_CAPTURE_ID}`);
const SOURCE = Object.freeze({
  hsonDeployCommit: "a".repeat(40),
  hsonDemo2Gitlink: "b".repeat(40),
  hsonLiveGitlink: "c".repeat(40),
  intrastructureGitlink: "d".repeat(40),
});

function process_exists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function wait_for_process_absence(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (process_exists(pid) && Date.now() < deadline) await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  assert.equal(process_exists(pid), false, `capture process ${pid} must be absent`);
}

async function fixture_options(mode: string) {
  const deploymentRoot = await mkdtemp(join(tmpdir(), "certification-completion-"));
  const captureId = crypto.randomUUID();
  const candidate = join(deploymentRoot, ".deployment-work", `capture-fixture-${captureId}`);
  return {
    deploymentRoot,
    captureId,
    candidate,
    command: process.execPath,
    args: [FIXTURE],
    environment: {
      CERTIFICATION_COMPLETION_FIXTURE_MODE: mode,
      CERTIFICATION_COMPLETION_FIXTURE_SOURCE: JSON.stringify(SOURCE),
    },
    readSourceState: async () => SOURCE,
    naturalExitGraceMs: 25,
    pollMs: 5,
  } as const;
}

async function fixture_pid(candidate: string): Promise<number> {
  const pid = Number(await readFile(`${candidate}.pid`, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0);
  return pid;
}

function successful_process_result(): NodeProcessResult {
  return Object.freeze({
    stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false,
    exitCode: 0, signal: null, durationMs: 1, timedOut: false, cancelled: false, outputLimitExceeded: false,
    forceKilled: false, spawnError: undefined, ok: true,
  });
}

test("retained real certification candidate validates as PASS", () => {
  const result = validate_certification_terminal(RETAINED_CANDIDATE, RETAINED_CAPTURE_ID);
  assert.equal(result.status, "passed");
  assert.equal(result.captureId, RETAINED_CAPTURE_ID);
});

test("outer completion authority accepts terminal PASS after natural capture exit", async () => {
  const options = await fixture_options("pass-natural");
  try {
    const result = await supervise_certification_capture(options);
    assert.equal(result.status, "passed");
    assert.equal(result.process.forceKilled, false);
    assert.equal(result.process.exitCode, 0);
    await wait_for_process_absence(await fixture_pid(options.candidate));
  } finally {
    await rm(options.deploymentRoot, { recursive: true, force: true });
  }
});

test("terminal observed before child exit validates PASS and TERM-to-KILL reaps the child", async () => {
  const options = await fixture_options("pass-linger");
  try {
    const result = await supervise_certification_capture(options);
    assert.equal(result.status, "passed");
    assert.equal(result.process.forceKilled, true);
    await wait_for_process_absence(await fixture_pid(options.candidate));
  } finally {
    await rm(options.deploymentRoot, { recursive: true, force: true });
  }
});

test("child observation winning after valid terminal persistence validates the durable PASS", async () => {
  const options = await fixture_options("pass-natural");
  try {
    const prepared = spawnSync(options.command, options.args, {
      cwd: options.deploymentRoot,
      env: {
        ...process.env,
        ...options.environment,
        HSON_CERTIFICATION_CAPTURE_ID: options.captureId,
        HSON_CERTIFICATION_CAPTURE_CANDIDATE: options.candidate,
      },
    });
    assert.equal(prepared.status, 0, prepared.stderr.toString());
    const processResult = successful_process_result();
    const result = await supervise_certification_capture({
      ...options,
      launch: () => ({
        execution: { result: Promise.resolve(processResult), terminate() {} },
        metrics: () => ({ activeChildren: 0 }),
        dispose() {},
      }),
    });
    assert.equal(result.status, "passed");
    assert.equal(result.process, processResult);
  } finally {
    await rm(options.deploymentRoot, { recursive: true, force: true });
  }
});

test("outer completion authority preserves terminal FAIL while reaping a non-quiescent capture", async () => {
  const options = await fixture_options("fail-linger");
  try {
    const result = await supervise_certification_capture(options);
    assert.equal(result.status, "failed");
    assert.equal(result.process.forceKilled, true);
    await wait_for_process_absence(await fixture_pid(options.candidate));
  } finally {
    await rm(options.deploymentRoot, { recursive: true, force: true });
  }
});

test("capture exit without a valid terminal record is infrastructure failure", async () => {
  const options = await fixture_options("premature-exit");
  try {
    await assert.rejects(supervise_certification_capture(options), /CERTIFICATION_CAPTURE_TERMINAL_INVALID:CERTIFICATION_TERMINAL_INVALID/);
    await wait_for_process_absence(await fixture_pid(options.candidate));
  } finally {
    await rm(options.deploymentRoot, { recursive: true, force: true });
  }
});

test("capture exit with a malformed terminal record is transparent infrastructure failure", async () => {
  const options = await fixture_options("malformed-terminal");
  try {
    await assert.rejects(supervise_certification_capture(options), /CERTIFICATION_CAPTURE_TERMINAL_INVALID:CERTIFICATION_TERMINAL_INVALID/);
    await wait_for_process_absence(await fixture_pid(options.candidate));
  } finally {
    await rm(options.deploymentRoot, { recursive: true, force: true });
  }
});

test("a stale terminal record from another capture is rejected and the child is reaped", async () => {
  const options = await fixture_options("stale-terminal-linger");
  try {
    await assert.rejects(supervise_certification_capture(options), /CERTIFICATION_TERMINAL_CAPTURE_MISMATCH/);
    await wait_for_process_absence(await fixture_pid(options.candidate));
  } finally {
    await rm(options.deploymentRoot, { recursive: true, force: true });
  }
});

test("a terminal record whose retained source identity is not current is rejected", async () => {
  const options = await fixture_options("pass-natural");
  try {
    await assert.rejects(supervise_certification_capture({
      ...options,
      readSourceState: async () => ({ ...SOURCE, hsonDeployCommit: "e".repeat(40) }),
    }), /CERTIFICATION_PARENT_SOURCE_IDENTITY_MISMATCH/);
    await wait_for_process_absence(await fixture_pid(options.candidate));
  } finally {
    await rm(options.deploymentRoot, { recursive: true, force: true });
  }
});

test("durable source identity disagreement is rejected", async () => {
  const options = await fixture_options("source-mismatch");
  try {
    await assert.rejects(supervise_certification_capture(options), /CERTIFICATION_METADATA_SOURCE_MISMATCH/);
    await wait_for_process_absence(await fixture_pid(options.candidate));
  } finally {
    await rm(options.deploymentRoot, { recursive: true, force: true });
  }
});

test("selected and terminal result identity disagreement is rejected", async () => {
  const options = await fixture_options("selected-result-mismatch");
  try {
    await assert.rejects(supervise_certification_capture(options), /TEST_SELECTION_RESULT_SET_MISMATCH:certification-parent/);
    await wait_for_process_absence(await fixture_pid(options.candidate));
  } finally {
    await rm(options.deploymentRoot, { recursive: true, force: true });
  }
});

test("terminal PASS cannot override invalid cleanup or report authority", async (context) => {
  for (const [mode, pattern] of [
    ["invalid-cleanup-linger", /CERTIFICATION_CLEANUP_CLIENT_SOCKETS_REMAIN/],
    ["invalid-report-linger", /CERTIFICATION_RUN_NOT_PASSED|CERTIFICATION_REPORT_NOT_PASSED/],
  ] as const) {
    await context.test(mode, async () => {
      const options = await fixture_options(mode);
      try {
        await assert.rejects(supervise_certification_capture(options), pattern);
        await wait_for_process_absence(await fixture_pid(options.candidate));
      } finally {
        await rm(options.deploymentRoot, { recursive: true, force: true });
      }
    });
  }
});

test("PipeWrap and ProcessWrap diagnostics and other non-authoritative bookkeeping do not veto PASS", async () => {
  const options = await fixture_options("pass-diagnostics");
  try {
    const result = await supervise_certification_capture(options);
    assert.equal(result.status, "passed");
    await wait_for_process_absence(await fixture_pid(options.candidate));
  } finally {
    await rm(options.deploymentRoot, { recursive: true, force: true });
  }
});

test("valid terminal PASS with unprovable process settlement is infrastructure failure", async () => {
  const options = await fixture_options("pass-natural");
  const prepared = spawnSync(process.execPath, [FIXTURE], {
    env: {
      ...process.env,
      ...options.environment,
      HSON_CERTIFICATION_CAPTURE_ID: options.captureId,
      HSON_CERTIFICATION_CAPTURE_CANDIDATE: options.candidate,
    },
  });
  assert.equal(prepared.status, 0);
  let active = 1;
  let resolveResult!: (result: NodeProcessResult) => void;
  const result = new Promise<NodeProcessResult>((resolveValue) => { resolveResult = resolveValue; });
  const failedSettlement = Object.freeze({
    stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false,
    exitCode: null, signal: null, durationMs: 1, timedOut: false, cancelled: false, outputLimitExceeded: false,
    forceKilled: true, spawnError: "PROCESS_TREE_SETTLEMENT_FAILED", ok: false,
  });
  try {
    await assert.rejects(supervise_certification_capture({
      ...options,
      launch: () => ({
        execution: { result, terminate() { active = 0; resolveResult(failedSettlement); } },
        metrics: () => ({ activeChildren: active }),
        dispose() { if (active !== 0) { active = 0; resolveResult(failedSettlement); } },
      }),
    }), /CERTIFICATION_CAPTURE_FAILURE_AND_SETTLEMENT_FAILURE|CERTIFICATION_CAPTURE_SETTLEMENT_FAILED/);
  } finally {
    await rm(options.deploymentRoot, { recursive: true, force: true });
  }
});
