import assert from "node:assert/strict";
import test from "node:test";
import { execute_deploy } from "./deploy.mjs";

function runner(calls, failAt) {
  return (command, arguments_, options) => {
    const invocation = `${command} ${arguments_.join(" ")}`;
    calls.push({ invocation, options });
    if (invocation === failAt) throw new Error(`failed: ${invocation}`);
    return "";
  };
}

function receipt() {
  return { reusable: true, receipt: { deploymentCommit: "a".repeat(40) } };
}

test("deploy reconciles and verifies before reusing a matching certified artifact", () => {
  const calls = [];
  const result = execute_deploy({ deploymentRoot: "/fixture/hson-deploy", run: runner(calls), inspectReuse: receipt, environment: {} });
  assert.equal(result.reused, true);
  assert.deepEqual(calls.map(({ invocation }) => invocation), [
    "npm run subs:update",
    "npm run verify",
    "npm run deploy:static",
  ]);
});

test("stale or mismatched certification recertifies before static deployment", () => {
  const calls = [];
  let inspections = 0;
  const result = execute_deploy({
    deploymentRoot: "/fixture/hson-deploy",
    run: runner(calls),
    inspectReuse: () => ++inspections === 1
      ? ({ reusable: false, reason: "source mismatch" })
      : ({ reusable: true, generated: true, receipt: { deploymentCommit: "a".repeat(40) } }),
    environment: {},
  });
  assert.equal(result.reused, false);
  assert.deepEqual(calls.map(({ invocation }) => invocation), [
    "npm run subs:update",
    "npm run verify",
    "npm run certify",
    "npm run deploy:static",
  ]);
});

for (const [label, failure, expected] of [
  ["dirty or unsafe Git reconciliation", "npm run subs:update", ["npm run subs:update"]],
  ["workspace verification", "npm run verify", ["npm run subs:update", "npm run verify"]],
  ["certification", "npm run certify", ["npm run subs:update", "npm run verify", "npm run certify"]],
]) {
  test(`${label} failure prevents provider deployment`, () => {
    const calls = [];
    assert.throws(() => execute_deploy({
      deploymentRoot: "/fixture/hson-deploy",
      run: runner(calls, failure),
      inspectReuse: () => ({ reusable: false, reason: "not reusable" }),
      environment: {},
    }), /failed:/);
    assert.deepEqual(calls.map(({ invocation }) => invocation), expected);
    assert.ok(calls.every(({ invocation }) => invocation !== "npm run deploy:static"));
  });
}

test("successful certification command without a reusable artifact still prevents deployment", () => {
  const calls = [];
  assert.throws(() => execute_deploy({
    deploymentRoot: "/fixture/hson-deploy",
    run: runner(calls),
    inspectReuse: () => ({ reusable: false, reason: "receipt or bytes invalid" }),
    environment: {},
  }), /without a reusable certified artifact/);
  assert.deepEqual(calls.map(({ invocation }) => invocation), [
    "npm run subs:update",
    "npm run verify",
    "npm run certify",
  ]);
});

test("default deploy never selects Worker deployment", () => {
  const calls = [];
  execute_deploy({ deploymentRoot: "/fixture/hson-deploy", run: runner(calls), inspectReuse: receipt, environment: {} });
  assert.ok(calls.every(({ invocation }) => !invocation.includes("deploy:worker")));
  assert.equal(calls.at(-1).invocation, "npm run deploy:static");
});
