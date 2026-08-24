#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect_reusable_certified_artifact } from "./static-deployment-authority.mjs";

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

  run("npm", ["run", "subs:update"], { cwd: deploymentRoot, env: environment });
  run("npm", ["run", "verify"], { cwd: deploymentRoot, env: environment });

  const inspectReuse = options.inspectReuse ?? inspect_reusable_certified_artifact;
  let reuse = inspectReuse({ deploymentRoot });
  const reusedExisting = reuse.reusable;
  if (reuse.reusable) {
    console.log(`Reusing certified static artifact for ${reuse.receipt.deploymentCommit}.`);
  } else {
    console.log(`Certified artifact is not reusable (${reuse.reason}); running certification.`);
    run("npm", ["run", "certify"], { cwd: deploymentRoot, env: environment });
    reuse = inspectReuse({ deploymentRoot });
    if (!reuse.reusable) {
      throw new Error(`Certification completed without a reusable certified artifact: ${reuse.reason}.`);
    }
  }

  run("npm", ["run", "deploy:static"], { cwd: deploymentRoot, env: environment });
  return Object.freeze({ reused: reusedExisting });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { execute_deploy(); }
  catch (error) {
    console.error(`deploy: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
