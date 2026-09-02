import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { execute_deploy, execute_deploy_latest } from "./deploy.mjs";

const certified = "a".repeat(40);
const current = "b".repeat(40);

test("public deploy logic has no unconditional local pack-origin fallback", () => {
  for (const file of ["deploy.mjs", "deploy-static.mjs", "static-deployment-authority.mjs"]) {
    const source = readFileSync(join(import.meta.dirname, file), "utf8");
    assert.doesNotMatch(source, /ws:\/\/127\.0\.0\.1:8787|LOCAL_PACK_LIVEHOST_WS_URL/);
  }
});

function runner(calls, failAt) {
  return (command, arguments_, options) => {
    const invocation = `${command} ${arguments_.join(" ")}`;
    calls.push({ invocation, options });
    if (invocation === failAt) throw new Error(`failed: ${invocation}`);
    return "";
  };
}

function valid(freshness = "current", publication = { suitable: true }) {
  return {
    valid: true,
    freshness,
    certifiedDeploymentCommit: certified,
    currentDeploymentCommit: freshness === "current" ? certified : current,
    receipt: { deploymentCommit: certified },
    publication,
  };
}

test("ordinary deploy reuses a valid current artifact without source sync or certification", () => {
  const calls = [];
  const inspections = [];
  const environment = { VITE_LIVEHOST_WS_URL: "wss://runtime.example" };
  const result = execute_deploy({
    deploymentRoot: "/fixture/hson-deploy",
    run: runner(calls),
    inspectReuse: (options) => { inspections.push(options); return valid(); },
    environment,
    log() {},
  });
  assert.equal(result.reused, true);
  assert.equal(inspections[0].environment, environment);
  assert.deepEqual(calls.map(({ invocation }) => invocation), ["npm run deploy:static"]);
});

test("ordinary deploy does not reuse an artifact certified for a different deployment commit", () => {
  const calls = [];
  let inspections = 0;
  const result = execute_deploy({
    deploymentRoot: "/fixture/hson-deploy",
    run: runner(calls),
    inspectReuse: () => ++inspections === 1 ? valid("stale") : valid(),
    environment: {},
    log() {},
  });
  assert.equal(result.reused, false);
  assert.deepEqual(calls.map(({ invocation }) => invocation), ["npm run certify", "npm run deploy:static"]);
});

test("ordinary deploy never certifies a valid current loopback artifact and fails before static deploy", () => {
  const calls = [];
  const publication = {
    suitable: false,
    reason: "Certified artifact is valid but uses local runtime origin ws://127.0.0.1:8787; public deployment requires an explicit public wss:// runtime origin.",
  };
  assert.throws(() => execute_deploy({
    deploymentRoot: "/fixture/hson-deploy",
    run: runner(calls),
    inspectReuse: () => valid("current", publication),
    environment: {},
    log() {},
  }), /valid but uses local runtime origin ws:\/\/127\.0\.0\.1:8787/);
  assert.deepEqual(calls, []);
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
  }), /without a valid current-source certified artifact/);
  assert.deepEqual(calls.map(({ invocation }) => invocation), ["npm run certify"]);
});

test("ordinary deploy invokes no source synchronization, verification, or Git command", () => {
  const calls = [];
  execute_deploy({ deploymentRoot: "/fixture/hson-deploy", run: runner(calls), inspectReuse: () => valid(), environment: {}, log() {} });
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
