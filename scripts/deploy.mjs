#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert_publication_suitable, inspect_reusable_certified_artifact } from "./static-deployment-authority.mjs";

function run_command(command, arguments_, options = {}) {
  return execFileSync(command, arguments_, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: "inherit",
  });
}

export function execute_deploy(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const run = options.run ?? run_command;
  const environment = options.environment ?? process.env;
  run("npm", ["run", "deploy:static"], { cwd: deploymentRoot, env: environment });
  return Object.freeze({ route: "static" });
}

export function execute_deploy_latest(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const run = options.run ?? run_command;
  const environment = options.environment ?? process.env;
  const log = options.log ?? console.log;
  const inspectReuse = options.inspectReuse ?? inspect_reusable_certified_artifact;

  run("npm", ["run", "subs:update"], { cwd: deploymentRoot, env: environment });
  run("npm", ["run", "verify"], { cwd: deploymentRoot, env: environment });

  let reuse = inspectReuse({ deploymentRoot, environment });
  const reusedExisting = reuse.valid && reuse.freshness === "current";
  if (reusedExisting) {
    log(`Reusing current certified static artifact for ${reuse.certifiedDeploymentCommit}.`);
  } else {
    const reason = reuse.valid
      ? `available certification is ${reuse.freshness} (${reuse.certifiedDeploymentCommit})`
      : reuse.reason;
    log(`No valid current-source certification is available (${reason}); certifying the synchronized deployment revision.`);
    run("npm", ["run", "certify"], { cwd: deploymentRoot, env: environment });
    reuse = inspectReuse({ deploymentRoot, environment });
    if (!reuse.valid || reuse.freshness !== "current") {
      const result = reuse.valid ? `artifact freshness is ${reuse.freshness}` : reuse.reason;
      throw new Error(`Certification completed without a valid current-source certified artifact: ${result}.`);
    }
  }

  assert_publication_suitable(reuse);
  run("npm", ["run", "deploy:static"], { cwd: deploymentRoot, env: environment });
  return Object.freeze({ reused: reusedExisting });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3 || (process.argv[2] !== undefined && process.argv[2] !== "--latest")) {
      throw new Error("Usage: node scripts/deploy.mjs [--latest]");
    }
    if (process.argv[2] === "--latest") execute_deploy_latest();
    else execute_deploy();
  }
  catch (error) {
    console.error(`deploy: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
