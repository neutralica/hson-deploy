import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run_build_static_command } from "./build-static.mjs";
import { DEPLOYMENT_LOCK_OWNER_FILE, acquire_deployment_lock } from "./deployment-lock.mjs";
import { run_static_deploy_command } from "./deploy-static.mjs";
import { run_worker_deploy_command } from "./deploy-worker.mjs";
import { run_complete_deploy_command } from "./deploy.mjs";
import { run_latest_deploy_command } from "./deploy-latest.mjs";
import { run_subs_update_command } from "./subs-update.mjs";

test("lock records ownership and releases through explicit ownership", async () => {
  const deploymentRoot = await mkdtemp(join(tmpdir(), "hson-deployment-lock-"));
  const lock = await acquire_deployment_lock({ deploymentRoot, command: "fixture" });
  const owner = JSON.parse(await readFile(join(lock.path, DEPLOYMENT_LOCK_OWNER_FILE), "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.command, "fixture");
  assert.match(owner.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  await lock.release();
});

test("every public deployment command fails immediately while the checkout lock is held", async () => {
  const deploymentRoot = await mkdtemp(join(tmpdir(), "hson-deployment-overlap-"));
  const held = await acquire_deployment_lock({ deploymentRoot, command: "first deployment" });
  let touched = 0;
  const attempts = [
    () => run_build_static_command({ deploymentRoot, build: async () => { touched += 1; } }),
    () => run_static_deploy_command({ deploymentRoot, execute: async () => { touched += 1; } }),
    () => run_worker_deploy_command({ deploymentRoot, execute: async () => { touched += 1; } }),
    () => run_complete_deploy_command({ deploymentRoot, execute: async () => { touched += 1; } }),
    () => run_subs_update_command({ deploymentRoot, synchronize: async () => { touched += 1; } }),
    () => run_latest_deploy_command({ deploymentRoot, deploy: async () => { touched += 1; } }),
  ];
  try {
    for (const attempt of attempts) await assert.rejects(attempt(), /already held.*manually remove/s);
    assert.equal(touched, 0);
  } finally {
    await held.release();
  }
});

test("a stale lock is never inferred or removed automatically", async () => {
  const deploymentRoot = await mkdtemp(join(tmpdir(), "hson-deployment-stale-lock-"));
  const held = await acquire_deployment_lock({ deploymentRoot, command: "crashed fixture" });
  await assert.rejects(acquire_deployment_lock({ deploymentRoot, command: "second" }), /crashed fixture.*manually remove/s);
  assert.equal(JSON.parse(await readFile(join(held.path, DEPLOYMENT_LOCK_OWNER_FILE), "utf8")).command, "crashed fixture");
  await held.release();
});
