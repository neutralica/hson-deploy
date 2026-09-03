import assert from "node:assert/strict";
import test from "node:test";
import { execute_worker_deploy, preflight_worker_target } from "./deploy-worker.mjs";

const target = Object.freeze({
  name: "fixture-worker",
  entrypoint: "src/server/cloudflare/worker.ts",
  wranglerConfig: "wrangler.jsonc",
  wranglerEnvironment: null,
  publicWebSocketOrigin: "wss://worker.example",
  productionStaticOrigins: ["https://hson-deploy.pages.dev"],
});

test("standalone Worker deployment prepares once and uploads only the Worker", async () => {
  const order = [];
  const result = await execute_worker_deploy({
    deploymentRoot: "/fixture/hson-deploy",
    environment: {},
    verifyWorkspace: () => order.push("verify workspace"),
    buildDependency: () => order.push("build hson-live"),
    check: () => order.push("check Worker"),
    loadTarget: async () => { order.push("load target"); return target; },
    verifyAuthentication: () => order.push("authenticate"),
    preflightTarget: async () => { order.push("guard Worker target"); return { target, deployments: 1 }; },
    upload: () => { order.push("upload Worker"); return "worker"; },
  });
  assert.equal(result, "worker");
  assert.deepEqual(order, ["verify workspace", "build hson-live", "check Worker", "load target", "authenticate", "guard Worker target", "upload Worker"]);
  assert.equal(order.filter((step) => step === "build hson-live").length, 1);
});

test("Worker target guard checks the exact configured name and default environment", async () => {
  const calls = [];
  const result = await preflight_worker_target({
    deploymentRoot: "/fixture/hson-deploy",
    environment: {},
    target,
    authenticationChecked: true,
    run(command, arguments_, options) { calls.push({ command, arguments_, options }); return '[{"id":"existing"}]'; },
  });
  assert.equal(result.deployments, 1);
  assert.deepEqual(calls.map(({ command, arguments_ }) => `${command} ${arguments_.join(" ")}`), [
    "wrangler deployments list --config wrangler.jsonc --name fixture-worker --json",
  ]);
  assert.equal(calls[0].options.cwd, "/fixture/hson-deploy/hson-demo2");
});

test("missing authenticated Worker target fails before upload eligibility", async () => {
  await assert.rejects(preflight_worker_target({
    deploymentRoot: "/fixture/hson-deploy",
    environment: {},
    target,
    authenticationChecked: true,
    run: () => "[]",
  }), /has no existing deployments/);
});
