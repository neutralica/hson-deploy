import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEPLOYMENT_CAPTURE_TERMINAL_OUTPUT_LIMIT_BYTES,
  run_deployment_capture_command,
} from "../capture-deployment-tests.mjs";

async function bounded<T>(promise: Promise<T>, milliseconds = 250): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("terminal output did not settle")), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("small capture failures render a concise operator result", async () => {
  const output: string[] = [];
  const result = await run_deployment_capture_command([], {
    capture: async () => { throw new Error("synthetic failure"); },
    writeOutput(fd, value) { output.push(`${fd}:${value}`); },
  });
  assert.equal(result, 1);
  assert.deepEqual(output, ["2:DEPLOYMENT CAPTURE FAILED\n\nFailure: synthetic failure\n"]);
});

test("certification report failures list only the failed suite identities", async () => {
  const output: string[] = [];
  const summary = JSON.stringify({
    failingSuites: [
      { id: "verification/library/test-diagnostics-inventory", evidence: "x".repeat(1024) },
      { id: "verification/demo/test-external-launcher-manifest-audit-node" },
      { id: "verification/demo/test-phase6a-full-node-hosted" },
    ],
  });
  const result = await run_deployment_capture_command(["--certification-only"], {
    capture: async () => { throw new Error(`DEPLOYMENT_CAPTURE_REPORT_FAILED:certification:${summary}`); },
    writeOutput(fd, value) { assert.equal(fd, 2); output.push(value); },
  });
  assert.equal(result, 1);
  assert.equal(output.length, 1);
  assert.match(output[0]!, /Failed suites: 3/);
  assert.match(output[0]!, /- verification\/library\/test-diagnostics-inventory/);
  assert.match(output[0]!, /- verification\/demo\/test-external-launcher-manifest-audit-node/);
  assert.match(output[0]!, /- verification\/demo\/test-phase6a-full-node-hosted/);
  assert.equal(output[0]!.includes("x".repeat(1024)), false);
});

test("large durable diagnostics remain locatable while terminal failure output stays bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "capture-command-output-"));
  const candidate = join(root, "capture-candidate");
  const diagnosticsPath = join(candidate, "capture-diagnostics.json");
  const diagnostic = JSON.stringify({ retained: "x".repeat(2 * 1024 * 1024) });
  await mkdir(candidate);
  await writeFile(diagnosticsPath, diagnostic);
  const priorCandidate = process.env.HSON_CERTIFICATION_CAPTURE_CANDIDATE;
  process.env.HSON_CERTIFICATION_CAPTURE_CANDIDATE = candidate;
  let terminal = "";
  try {
    const result = await bounded(run_deployment_capture_command(["--certification-only"], {
      capture: async () => { throw new Error(`semantic failure\n${diagnostic}`); },
      writeOutput(fd, value) { assert.equal(fd, 2); terminal += value; },
    }));
    assert.equal(result, 1);
    assert.ok(Buffer.byteLength(terminal) <= DEPLOYMENT_CAPTURE_TERMINAL_OUTPUT_LIMIT_BYTES);
    assert.equal(terminal.includes(diagnostic), false);
    assert.match(terminal, /^CERTIFICATION FAILED\n/);
    assert.match(terminal, /Retained diagnostics:/);
    assert.ok(terminal.includes(diagnosticsPath));
    assert.equal(await readFile(diagnosticsPath, "utf8"), diagnostic);
  } finally {
    if (priorCandidate === undefined) delete process.env.HSON_CERTIFICATION_CAPTURE_CANDIDATE;
    else process.env.HSON_CERTIFICATION_CAPTURE_CANDIDATE = priorCandidate;
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal EAGAIN cannot replace or delay the semantic failure result", async () => {
  let writes = 0;
  const result = await bounded(run_deployment_capture_command(["--certification-only"], {
    capture: async () => { throw new Error("semantic failure"); },
    writeOutput() {
      writes += 1;
      const error = new Error("resource temporarily unavailable") as NodeJS.ErrnoException;
      error.code = "EAGAIN";
      throw error;
    },
  }));
  assert.equal(result, 1);
  assert.equal(writes, 1);
});
