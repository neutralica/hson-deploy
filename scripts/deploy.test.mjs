import assert from "node:assert/strict";
import test from "node:test";
import { execute_deploy, execute_deploy_latest } from "./deploy.mjs";

const certified = "a".repeat(40);
const current = "b".repeat(40);

function runner(calls, failAt) {
  return (command, arguments_, options) => {
    const invocation = `${command} ${arguments_.join(" ")}`;
    calls.push({ invocation, options });
    if (invocation === failAt) throw new Error(`failed: ${invocation}`);
    return "";
  };
}

function valid(freshness = "current") {
  return {
    valid: true,
    freshness,
    certifiedDeploymentCommit: certified,
    currentDeploymentCommit: freshness === "current" ? certified : current,
    receipt: { deploymentCommit: certified },
  };
}

test("ordinary deploy reuses a valid current artifact without source sync or certification", () => {
  const calls = [];
  const result = execute_deploy({ deploymentRoot: "/fixture/hson-deploy", run: runner(calls), inspectReuse: () => valid(), environment: {}, log() {} });
  assert.equal(result.reused, true);
  assert.deepEqual(calls.map(({ invocation }) => invocation), ["npm run deploy:static"]);
});

test("ordinary deploy accepts a valid stale artifact and reports its freshness", () => {
  const calls = [];
  const logs = [];
  const result = execute_deploy({ deploymentRoot: "/fixture/hson-deploy", run: runner(calls), inspectReuse: () => valid("stale"), environment: {}, log: (line) => logs.push(line) });
  assert.equal(result.reused, true);
  assert.deepEqual(calls.map(({ invocation }) => invocation), ["npm run deploy:static"]);
  assert.match(logs.join("\n"), /Freshness .* STALE/);
  assert.match(logs.join("\n"), new RegExp(`Deploying certified artifact ${certified}`));
});

for (const reason of ["certification receipt missing or invalid", "artifact hash mismatch"]) {
  test(`ordinary deploy certifies once when existing artifact is invalid: ${reason}`, () => {
    const calls = [];
    let inspections = 0;
    const result = execute_deploy({
      deploymentRoot: "/fixture/hson-deploy",
      run: runner(calls),
      inspectReuse: () => ++inspections === 1 ? { valid: false, reason } : valid(),
      environment: {},
      log() {},
    });
    assert.equal(result.reused, false);
    assert.deepEqual(calls.map(({ invocation }) => invocation), ["npm run certify", "npm run deploy:static"]);
  });
}

test("certification fallback failure prevents deployment", () => {
  const calls = [];
  assert.throws(() => execute_deploy({
    deploymentRoot: "/fixture/hson-deploy",
    run: runner(calls, "npm run certify"),
    inspectReuse: () => ({ valid: false, reason: "missing" }),
    environment: {},
    log() {},
  }), /failed: npm run certify/);
  assert.deepEqual(calls.map(({ invocation }) => invocation), ["npm run certify"]);
});

test("successful fallback without a valid result prevents deployment", () => {
  const calls = [];
  assert.throws(() => execute_deploy({
    deploymentRoot: "/fixture/hson-deploy",
    run: runner(calls),
    inspectReuse: () => ({ valid: false, reason: "receipt or bytes invalid" }),
    environment: {},
    log() {},
  }), /without a valid certified artifact/);
  assert.deepEqual(calls.map(({ invocation }) => invocation), ["npm run certify"]);
});

test("ordinary deploy invokes no source synchronization, verification, or Git command", () => {
  const calls = [];
  execute_deploy({ deploymentRoot: "/fixture/hson-deploy", run: runner(calls), inspectReuse: () => valid("stale"), environment: {}, log() {} });
  const invocations = calls.map(({ invocation }) => invocation).join("\n");
  assert.doesNotMatch(invocations, /subs:update|npm run verify(?:\s|$)|\bgit\b|commit|push/);
  assert.match(invocations, /npm run deploy:static/);
});

test("deploy:latest synchronizes and certifies when the available valid artifact is stale", () => {
  const calls = [];
  let inspections = 0;
  const result = execute_deploy_latest({
    deploymentRoot: "/fixture/hson-deploy",
    run: runner(calls),
    inspectReuse: () => ++inspections === 1 ? valid("stale") : valid(),
    environment: {},
    log() {},
  });
  assert.equal(result.reused, false);
  assert.deepEqual(calls.map(({ invocation }) => invocation), [
    "npm run subs:update",
    "npm run verify",
    "npm run certify",
    "npm run deploy:static",
  ]);
});

test("deploy:latest reuses an exact-current valid artifact", () => {
  const calls = [];
  const result = execute_deploy_latest({ deploymentRoot: "/fixture/hson-deploy", run: runner(calls), inspectReuse: () => valid(), environment: {}, log() {} });
  assert.equal(result.reused, true);
  assert.deepEqual(calls.map(({ invocation }) => invocation), [
    "npm run subs:update",
    "npm run verify",
    "npm run deploy:static",
  ]);
});

test("deploy:latest refuses a non-current artifact after certification", () => {
  const calls = [];
  assert.throws(() => execute_deploy_latest({
    deploymentRoot: "/fixture/hson-deploy",
    run: runner(calls),
    inspectReuse: () => valid("stale"),
    environment: {},
    log() {},
  }), /without a valid current-source certified artifact/);
  assert.deepEqual(calls.map(({ invocation }) => invocation), ["npm run subs:update", "npm run verify", "npm run certify"]);
});
