#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load_worker_deployment_target } from "../hson-demo2/scripts/worker-deployment-target.mjs";
import { build_static } from "./build-static.mjs";
import { with_deployment_lock } from "./deployment-lock.mjs";
import { PAGES_PUBLIC_ORIGIN, preflight_static_deploy, upload_static_artifact } from "./deploy-static.mjs";
import { check_worker, preflight_worker_target, upload_worker, verify_local_deployment_workspace } from "./deploy-worker.mjs";
import { verify_cloudflare_authentication } from "./preflight-cloudflare.mjs";

export function verify_worker_static_target_agreement(staticPreflight, workerTarget) {
  const embedded = staticPreflight.verification.liveHostOrigin;
  const intended = new URL(workerTarget.publicWebSocketOrigin).origin;
  if (embedded !== intended) throw new Error(`Static/Worker target mismatch: static embeds ${embedded}; TOWL Worker target is ${intended}.`);
  if (!workerTarget.productionStaticOrigins.includes(PAGES_PUBLIC_ORIGIN)) {
    throw new Error(`TOWL Worker browser-origin policy does not admit the production Pages origin ${PAGES_PUBLIC_ORIGIN}.`);
  }
  return Object.freeze({ workerOrigin: intended, staticOrigin: PAGES_PUBLIC_ORIGIN });
}

export async function execute_complete_deploy(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const environment = options.environment ?? process.env;
  const demoRoot = resolve(deploymentRoot, "hson-demo2");
  await (options.verifyWorkspace ?? verify_local_deployment_workspace)({ deploymentRoot, environment, run: options.runLocal });
  const workerTarget = await (options.loadTarget ?? load_worker_deployment_target)({ repositoryRoot: demoRoot, environment });
  const explicitlyConfigured = environment.VITE_LIVEHOST_WS_URL?.trim();
  if (explicitlyConfigured && new URL(explicitlyConfigured).origin !== workerTarget.publicWebSocketOrigin) {
    throw new Error("VITE_LIVEHOST_WS_URL disagrees with the production TOWL Worker target. Remove it or set it to HSON_TOWL_WORKER_WS_ORIGIN.");
  }
  const buildResult = await (options.buildStatic ?? build_static)({
    deploymentRoot,
    environment: { ...environment, VITE_LIVEHOST_WS_URL: workerTarget.publicWebSocketOrigin },
  });
  await (options.checkWorker ?? check_worker)({ deploymentRoot, environment, run: options.runLocal });
  await (options.verifyAuthentication ?? verify_cloudflare_authentication)({ environment, run: options.runAuthentication });
  const staticPreflight = await (options.preflightStatic ?? preflight_static_deploy)({ deploymentRoot, environment, authenticationChecked: true, run: options.runProvider });
  const workerPreflight = await (options.preflightWorker ?? preflight_worker_target)({ deploymentRoot, environment, target: workerTarget, authenticationChecked: true, run: options.runProvider });
  const agreement = await (options.verifyAgreement ?? verify_worker_static_target_agreement)(staticPreflight, workerTarget);
  const worker = await (options.uploadWorker ?? upload_worker)(workerPreflight, { deploymentRoot, environment, run: options.runProvider });
  const staticDeployment = await (options.uploadStatic ?? upload_static_artifact)(staticPreflight, { deploymentRoot, environment, run: options.runProvider });
  return Object.freeze({ build: buildResult, agreement, worker, static: staticDeployment });
}

export async function run_complete_deploy_command(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const lock = options.withLock ?? with_deployment_lock;
  const execute = options.execute ?? execute_complete_deploy;
  return lock({ deploymentRoot, command: "deploy" }, () => execute({ ...options, deploymentRoot }));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await run_complete_deploy_command(); }
  catch (error) {
    console.error(`deploy: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
