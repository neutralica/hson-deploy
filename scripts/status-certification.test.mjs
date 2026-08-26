import assert from "node:assert/strict";
import test from "node:test";

import { analyzeCertification, discoverCertificationChains, renderCertificationStatus } from "./status-certification.mjs";

const NOW = Date.parse("2026-08-25T21:00:00.000Z");

function process(pid, ppid, command, options = {}) {
  return {
    pid, ppid, command,
    elapsed: options.elapsed ?? "00:04:54",
    cpu: options.cpu ?? 0,
    memory: options.memory ?? 0.8,
    stateCode: options.stateCode ?? "S+",
  };
}

function captureProcess(pid = 300, ppid = 200, options = {}) {
  return process(pid, ppid, "/usr/local/bin/node ./node_modules/tsx/dist/cli.mjs scripts/capture-deployment-tests.mts --certification-only", options);
}

function chain(capture = captureProcess()) {
  return [
    process(100, 1, "npm run certify"),
    process(150, 100, "npm -w hson-demo2 run certify"),
    process(200, 150, "node scripts/certified-package.mjs certify"),
    capture,
  ];
}

function records(overrides = {}) {
  const missing = { exists: false };
  return {
    name: "capture-mt-active-0000",
    path: "/fixture/.deployment-work/capture-mt-active-0000",
    createdMs: NOW - 280_000,
    metadata: missing,
    certification: missing,
    cleanup: missing,
    terminal: missing,
    ...overrides,
  };
}

test("no certification running reports NOT RUNNING successfully", () => {
  const result = analyzeCertification({
    processes: [process(900, 1, "node unrelated.mjs"), process(901, 1, "node /tmp/hson-h2/run-old/server.mjs")],
    nowMs: NOW,
  });
  assert.equal(result.status, "NOT RUNNING");
  assert.equal(result.historicalUnownedH2, 1);
  assert.match(renderCertificationStatus(result), /Status \.{2,} NOT RUNNING/);
});

test("the durable-terminal supervisor is itself an observable certification principal", () => {
  const processes = [process(100, 1, "node --import=tsx scripts/supervise-certification-capture.mts")];
  const result = analyzeCertification({ processes, captureCandidates: [], sockets: [], nowMs: NOW });
  assert.equal(result.status, "SUSPICIOUS / QUIESCENT");
  assert.equal(result.chain.principal.pid, 100);
});

test("unavailable process inspection never masquerades as NOT RUNNING", () => {
  const result = analyzeCertification({ processes: [], processInspectionAvailable: false, nowMs: NOW });
  assert.equal(result.status, "UNKNOWN — PROCESS INSPECTION UNAVAILABLE");
  assert.match(renderCertificationStatus(result), /No running\/not-running conclusion was inferred/);
});

test("active capture with live child reports semantic current work and plain ACTIVE assessment", () => {
  const processes = [
    ...chain(captureProcess(300, 200, { cpu: 43.4 })),
    process(400, 300, "npm -w hson-demo2 run test:phase6b-full-browser-hosted", { elapsed: "00:01:14", cpu: 3.1 }),
    process(410, 400, "node /tmp/hson-h2/run-9045844a-a1/hosted-test-server.mjs"),
    process(999, 1, "node /tmp/hson-h2/run-historical/server.mjs"),
  ];
  const result = analyzeCertification({
    processes,
    sockets: [{ pid: 410, state: "LISTEN", name: "127.0.0.1:49886" }, { pid: 410, state: "ESTABLISHED", name: "127.0.0.1:49886->127.0.0.1:49887" }],
    captureCandidates: [records()], nowMs: NOW,
  });
  assert.equal(result.status, "ACTIVE");
  assert.deepEqual(result.work.map(({ name }) => name), ["test:phase6b-full-browser-hosted", "hosted-test-server"]);
  assert.equal(result.historicalUnownedH2, 1);
  const output = renderCertificationStatus(result);
  assert.match(output, /test:phase6b-full-browser-hosted/);
  assert.match(output, /Workspace \.{2,} run-9045844a-a1/);
  assert.match(output, / ASSESSMENT[\s\S]*\n ACTIVE\n\n={64}$/);
  assert.doesNotMatch(output, /Certification is doing observable work/);
});

test("quiescent capture is suspicious without elapsed-time dogma", () => {
  const result = analyzeCertification({ processes: chain(), captureCandidates: [records()], nowMs: NOW });
  assert.equal(result.status, "SUSPICIOUS / QUIESCENT");
  const output = renderCertificationStatus(result);
  assert.match(output, /no CPU activity, child work, or sockets/);
  assert.match(output, /does not automatically prove a hang/);
});

test("zombie direct child is detected but never acted upon", () => {
  const processes = [...chain(), process(401, 300, "[node] <defunct>", { stateCode: "Z+" })];
  const result = analyzeCertification({ processes, captureCandidates: [records()], nowMs: NOW });
  assert.equal(result.status, "ZOMBIE CHILD DETECTED");
  const output = renderCertificationStatus(result);
  assert.match(output, /Zombie children \.{2,} 1/);
  assert.match(output, /No process was terminated/);
});

test("terminal record while capture remains alive is prominent", () => {
  const candidate = records({ terminal: { exists: true, value: { status: "passed" } }, cleanup: { exists: true, value: {} } });
  const result = analyzeCertification({ processes: chain(), captureCandidates: [candidate], nowMs: NOW });
  assert.equal(result.status, "TERMINAL BUT PROCESS STILL ALIVE");
  const output = renderCertificationStatus(result);
  assert.match(output, /Terminal record \.{2,} terminal PASS/);
  assert.match(output, /durably completed and cleanup is settled/);
  assert.match(output, /capture CLI has not exited/);
});

test("multiple independent capture candidates are ambiguous", () => {
  const processes = [
    ...chain(captureProcess(300, 200)),
    process(500, 1, "npm run certify"),
    process(600, 500, "node scripts/certified-package.mjs certify"),
    captureProcess(700, 600, { elapsed: "00:02:00" }),
  ];
  const result = analyzeCertification({ processes, nowMs: NOW });
  assert.equal(result.status, "AMBIGUOUS — MULTIPLE CAPTURES");
  assert.deepEqual(result.chains.map(({ principal }) => principal.pid), [300, 700]);
  assert.match(renderCertificationStatus(result), /2 plausible independent certification captures/);
});

test("wrapper commands with the same capture identity collapse by ancestry", () => {
  const processes = [
    ...chain(process(300, 200, "sh -c ./node_modules/.bin/tsx scripts/capture-deployment-tests.mts --certification-only")),
    captureProcess(301, 300),
  ];
  const chains = discoverCertificationChains(processes);
  assert.equal(chains.length, 1);
  assert.equal(chains[0].principal.pid, 301);
});
