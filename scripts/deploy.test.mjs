import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { execute_complete_deploy, run_complete_deploy_command, verify_worker_static_target_agreement } from "./deploy.mjs";

const root = resolve(import.meta.dirname, "..");
const target = Object.freeze({
  name: "fixture-worker",
  entrypoint: "src/server/cloudflare/worker.ts",
  wranglerConfig: "wrangler.jsonc",
  wranglerEnvironment: null,
  publicWebSocketOrigin: "wss://worker.example",
  productionStaticOrigins: ["https://hson-deploy.pages.dev"],
});
const staticPreflight = Object.freeze({
  project: "hson-deploy",
  branch: "main",
  directory: "/fixture/hson-deploy/static-production",
  verification: { liveHostOrigin: "wss://worker.example" },
});

function fixture(overrides = {}) {
  const order = [];
  const options = {
    deploymentRoot: "/fixture/hson-deploy",
    environment: {},
    verifyWorkspace: () => order.push("verify workspace"),
    loadTarget: async () => { order.push("load target"); return target; },
    buildStatic: async () => { order.push("build static"); return "build"; },
    checkWorker: () => order.push("check Worker"),
    verifyAuthentication: () => order.push("authenticate"),
    preflightStatic: async () => { order.push("preflight static"); return staticPreflight; },
    preflightWorker: async () => { order.push("preflight Worker"); return { target, deployments: 1 }; },
    verifyAgreement: () => { order.push("verify agreement"); return "agreement"; },
    uploadWorker: async () => { order.push("upload Worker"); return "worker"; },
    uploadStatic: async () => { order.push("upload static"); return "static"; },
    ...overrides,
  };
  return { order, options };
}

test("complete deploy is locked, fully preflighted, Worker-first, and serial", async () => {
  const { order, options } = fixture();
  const result = await run_complete_deploy_command({
    ...options,
    withLock: async (_lockOptions, operation) => {
      order.push("lock");
      try { return await operation(); }
      finally { order.push("unlock"); }
    },
  });
  assert.deepEqual(order, [
    "lock", "verify workspace", "load target", "build static", "check Worker", "authenticate",
    "preflight static", "preflight Worker", "verify agreement", "upload Worker", "upload static", "unlock",
  ]);
  assert.deepEqual(result, { build: "build", agreement: "agreement", worker: "worker", static: "static" });
  assert.equal(order.filter((step) => step === "build static").length, 1);
  assert.equal(order.filter((step) => step === "build hson-live").length, 0);
});

test("every local, authentication, and target preflight failure prevents both uploads", async () => {
  const stages = ["verifyWorkspace", "loadTarget", "buildStatic", "checkWorker", "verifyAuthentication", "preflightStatic", "preflightWorker", "verifyAgreement"];
  for (const stage of stages) {
    const { order, options } = fixture({ [stage]: () => { order.push(`fail ${stage}`); throw new Error(stage); } });
    await assert.rejects(execute_complete_deploy(options), new RegExp(stage));
    assert.equal(order.includes("upload Worker"), false, stage);
    assert.equal(order.includes("upload static"), false, stage);
  }
});

test("Worker upload failure stops static upload", async () => {
  const { order, options } = fixture({ uploadWorker: async () => { order.push("upload Worker"); throw new Error("worker failed"); } });
  await assert.rejects(execute_complete_deploy(options), /worker failed/);
  assert.equal(order.includes("upload static"), false);
});

test("static upload failure propagates after successful Worker upload without rollback", async () => {
  const { order, options } = fixture({ uploadStatic: async () => { order.push("upload static"); throw new Error("static failed"); } });
  await assert.rejects(execute_complete_deploy(options), /static failed/);
  assert.equal(order.filter((step) => step === "upload Worker").length, 1);
  assert.equal(order.filter((step) => /rollback|retry/i.test(step)).length, 0);
});

test("static and Worker target agreement is exact and fail-closed", () => {
  assert.deepEqual(verify_worker_static_target_agreement(staticPreflight, target), {
    workerOrigin: "wss://worker.example",
    staticOrigin: "https://hson-deploy.pages.dev",
  });
  assert.throws(() => verify_worker_static_target_agreement({ ...staticPreflight, verification: { liveHostOrigin: "wss://other.example" } }, target), /target mismatch/);
  assert.throws(() => verify_worker_static_target_agreement(staticPreflight, { ...target, productionStaticOrigins: ["https://other.example"] }), /does not admit/);
});

test("plain deploy uses the tracked production Worker origin without source synchronization", async () => {
  const { order, options } = fixture({
    deploymentRoot: root,
    loadTarget: undefined,
    environment: {},
    buildStatic: async ({ environment }) => {
      order.push("build static");
      assert.equal(environment.VITE_LIVEHOST_WS_URL, "wss://hson-demo2-hosted-tests.hansonpw.workers.dev");
      return "build";
    },
    preflightStatic: async () => {
      order.push("preflight static");
      return { ...staticPreflight, verification: { liveHostOrigin: "wss://hson-demo2-hosted-tests.hansonpw.workers.dev" } };
    },
  });
  await execute_complete_deploy(options);
  assert.equal(order.some((step) => /subs:update|source sync/i.test(step)), false);
});

test("explicit Worker-origin override remains subject to exact static target agreement", async () => {
  const overridden = "wss://alternate.example";
  const { options } = fixture({
    deploymentRoot: root,
    loadTarget: undefined,
    environment: { HSON_TOWL_WORKER_WS_ORIGIN: overridden },
    buildStatic: async ({ environment }) => {
      assert.equal(environment.VITE_LIVEHOST_WS_URL, overridden);
      return "build";
    },
    preflightStatic: async () => ({ ...staticPreflight, verification: { liveHostOrigin: overridden } }),
  });
  const result = await execute_complete_deploy(options);
  assert.deepEqual(result.agreement, "agreement");

  const mismatch = fixture({
    deploymentRoot: root,
    loadTarget: undefined,
    environment: { HSON_TOWL_WORKER_WS_ORIGIN: overridden },
    verifyAgreement: undefined,
    preflightStatic: async () => staticPreflight,
  });
  await assert.rejects(execute_complete_deploy(mismatch.options), /target mismatch/);
});

test("public deployment scripts are narrow and cannot reach tests, pack, certification, or Git mutation", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const demoManifest = JSON.parse(readFileSync(resolve(root, "hson-demo2/package.json"), "utf8"));
  const liveManifest = JSON.parse(readFileSync(resolve(root, "hson-live/package.json"), "utf8"));
  assert.equal(manifest.scripts.deploy, "node scripts/deploy.mjs");
  assert.equal(manifest.scripts["build:static"], "npm run verify:runtime && node scripts/build-static.mjs");
  assert.equal(manifest.scripts["deploy:static"], "node scripts/deploy-static.mjs");
  assert.equal(manifest.scripts["deploy:worker"], "node scripts/deploy-worker.mjs");
  assert.equal(manifest.scripts["subs:update"], "node scripts/subs-update.mjs");
  assert.equal(manifest.scripts["deploy:latest"], "node scripts/deploy-latest.mjs");
  assert.doesNotMatch(readFileSync(resolve(import.meta.dirname, "deploy.mjs"), "utf8"), /subs-update|subs:update/);
  assert.equal(manifest.scripts.pack, undefined);
  assert.equal(manifest.scripts.certify, undefined);
  assert.equal(manifest.scripts["preflight:worker"], undefined);
  const sources = ["deploy.mjs", "deploy-static.mjs", "deploy-worker.mjs", "build-static.mjs", "deployment-lock.mjs", "preflight-cloudflare.mjs"]
    .map((file) => readFileSync(resolve(import.meta.dirname, file), "utf8")).join("\n");
  assert.doesNotMatch(sources, /npm\s+(?:run\s+)?pack|playwright|run-canonical-tests|tests\.runSelected|capture-deployment|accepted evidence/i);
  assert.doesNotMatch(sources, /git["'`]?,?\s*\[?\s*["'`](?:fetch|pull|checkout|restore|reset|merge|rebase|commit|submodule|update-index)/i);
  assert.doesNotMatch(Object.keys(manifest.scripts).join("\n"), /^certif(?:y|ication)|^pack(?::|$)/im);
  const fullDeployBuildChain = [
    demoManifest.scripts.prebuild,
    demoManifest.scripts["build:hson-live"],
    liveManifest.scripts.build,
    liveManifest.scripts["hson-schema:verify"],
    demoManifest.scripts.build,
    demoManifest.scripts["check:cloudflare"],
  ].join("\n");
  assert.equal(demoManifest.scripts.prebuild, "npm run build:hson-live");
  assert.equal((fullDeployBuildChain.match(/npm --prefix \.\.\/hson-live run build/g) ?? []).length, 1);
  assert.doesNotMatch(fullDeployBuildChain, /npm\s+(?:run\s+)?pack|npm\s+ci|npm\s+run\s+test(?::|\s)|playwright|vite\s+build.*vite\s+build/i);
});
