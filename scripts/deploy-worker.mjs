#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load_worker_deployment_target } from "../hson-demo2/scripts/worker-deployment-target.mjs";
import { with_deployment_lock } from "./deployment-lock.mjs";
import { verify_cloudflare_authentication } from "./preflight-cloudflare.mjs";

function run_command(command, arguments_, options = {}) {
  return execFileSync(command, arguments_, { cwd: options.cwd, env: options.env, encoding: "utf8", stdio: options.stdio ?? "inherit" });
}

function parse_array(output, label) {
  const start = output.indexOf("[");
  if (start < 0) throw new Error(`${label} did not return a JSON array.`);
  let value;
  try { value = JSON.parse(output.slice(start)); }
  catch (cause) { throw new Error(`${label} returned invalid JSON.`, { cause }); }
  if (!Array.isArray(value)) throw new Error(`${label} did not return a JSON array.`);
  return value;
}

export function verify_local_deployment_workspace(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const run = options.run ?? run_command;
  run("npm", ["run", "verify"], { cwd: deploymentRoot, env: options.environment ?? process.env });
}

export function build_worker_dependency(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const run = options.run ?? run_command;
  run("npm", ["-w", "hson-live", "run", "build"], { cwd: deploymentRoot, env: options.environment ?? process.env });
}

export function check_worker(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const run = options.run ?? run_command;
  run("npm", ["-w", "hson-demo2", "run", "check:cloudflare"], { cwd: deploymentRoot, env: options.environment ?? process.env });
}

export async function preflight_worker_target(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const demoRoot = resolve(deploymentRoot, "hson-demo2");
  const environment = options.environment ?? process.env;
  const run = options.run ?? run_command;
  const target = options.target ?? await load_worker_deployment_target({ repositoryRoot: demoRoot, environment });
  if (options.authenticationChecked !== true) (options.verifyAuthentication ?? verify_cloudflare_authentication)({ environment, run: options.runAuthentication });
  const arguments_ = ["deployments", "list", "--config", target.wranglerConfig, "--name", target.name, "--json"];
  if (target.wranglerEnvironment !== null) arguments_.push("--env", target.wranglerEnvironment);
  const deployments = parse_array(run("wrangler", arguments_, { cwd: demoRoot, env: environment, stdio: ["ignore", "pipe", "inherit"] }), "Wrangler Worker target guard");
  if (deployments.length === 0) throw new Error(`Cloudflare Worker target guard failed: ${target.name} has no existing deployments in the authenticated account.`);
  return Object.freeze({ target, deployments: deployments.length });
}

export function upload_worker(preflight, options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const demoRoot = resolve(deploymentRoot, "hson-demo2");
  const environment = options.environment ?? process.env;
  const run = options.run ?? run_command;
  const arguments_ = ["deploy", "--config", preflight.target.wranglerConfig];
  if (preflight.target.wranglerEnvironment !== null) arguments_.push("--env", preflight.target.wranglerEnvironment);
  const output = run("wrangler", arguments_, { cwd: demoRoot, env: environment, stdio: ["ignore", "pipe", "inherit"] });
  console.log(`Cloudflare accepted TOWL Worker ${preflight.target.name} (${preflight.target.wranglerEnvironment ?? "default"}).`);
  if (output.trim()) process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  return Object.freeze({ ...preflight, output });
}

export async function execute_worker_deploy(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const environment = options.environment ?? process.env;
  await (options.verifyWorkspace ?? verify_local_deployment_workspace)({ deploymentRoot, environment, run: options.runLocal });
  await (options.buildDependency ?? build_worker_dependency)({ deploymentRoot, environment, run: options.runLocal });
  await (options.check ?? check_worker)({ deploymentRoot, environment, run: options.runLocal });
  const target = await (options.loadTarget ?? load_worker_deployment_target)({ repositoryRoot: resolve(deploymentRoot, "hson-demo2"), environment });
  await (options.verifyAuthentication ?? verify_cloudflare_authentication)({ environment, run: options.runAuthentication });
  const preflight = await (options.preflightTarget ?? preflight_worker_target)({ deploymentRoot, environment, target, authenticationChecked: true, run: options.runProvider });
  return (options.upload ?? upload_worker)(preflight, { deploymentRoot, environment, run: options.runProvider });
}

export async function run_worker_deploy_command(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const lock = options.withLock ?? with_deployment_lock;
  const execute = options.execute ?? execute_worker_deploy;
  return lock({ deploymentRoot, command: "deploy:worker" }, () => execute({ ...options, deploymentRoot }));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await run_worker_deploy_command(); }
  catch (error) {
    console.error(`deploy:worker: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
