#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { with_deployment_lock } from "./deployment-lock.mjs";
import { execute_complete_deploy } from "./deploy.mjs";
import { MANAGED_SOURCE_SUBMODULES, print_source_gitlink_results, synchronize_source_gitlinks } from "./subs-update.mjs";

const MANAGED = new Set(MANAGED_SOURCE_SUBMODULES);

function run_command(command, arguments_, options = {}) {
  return execFileSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  }).trim();
}

function tracked_paths(run, deploymentRoot) {
  const output = run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: deploymentRoot });
  return output === "" ? [] : output.split("\n").map((line) => line.slice(3).split(" -> ").at(-1));
}

export function require_gitlink_only_deployment_state(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot);
  const run = options.run ?? run_command;
  const unrelated = tracked_paths(run, deploymentRoot).filter((path) => !MANAGED.has(path));
  if (unrelated.length > 0) throw new Error(`deploy:latest requires a clean hson-deploy source state; unrelated tracked changes: ${unrelated.join(", ")}.`);
}

export function commit_updated_source_gitlinks(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot);
  const run = options.run ?? run_command;
  require_gitlink_only_deployment_state({ deploymentRoot, run });
  run("git", ["add", "--", ...MANAGED_SOURCE_SUBMODULES], { cwd: deploymentRoot });
  const staged = run("git", ["diff", "--cached", "--name-only"], { cwd: deploymentRoot });
  const paths = staged === "" ? [] : staged.split("\n");
  const unrelated = paths.filter((path) => !MANAGED.has(path));
  if (unrelated.length > 0) throw new Error(`deploy:latest refuses to commit unrelated staged changes: ${unrelated.join(", ")}.`);
  if (paths.length === 0) return undefined;
  run("git", ["commit", "-m", "Update source gitlinks"], { cwd: deploymentRoot, stdio: "inherit" });
  return run("git", ["rev-parse", "HEAD"], { cwd: deploymentRoot });
}

export async function run_latest_deploy_command(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const lock = options.withLock ?? with_deployment_lock;
  const synchronize = options.synchronize ?? synchronize_source_gitlinks;
  const requireState = options.requireState ?? require_gitlink_only_deployment_state;
  const commitGitlinks = options.commitGitlinks ?? commit_updated_source_gitlinks;
  const deploy = options.deploy ?? execute_complete_deploy;
  return lock({ deploymentRoot, command: "deploy:latest" }, async () => {
    await requireState({ ...options, deploymentRoot });
    const synchronization = await synchronize({ ...options, deploymentRoot });
    (options.printResults ?? print_source_gitlink_results)(synchronization);
    const commit = await commitGitlinks({ ...options, deploymentRoot });
    const deployment = await deploy({ ...options, deploymentRoot });
    return Object.freeze({ synchronization, commit, deployment });
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await run_latest_deploy_command(); }
  catch (error) {
    console.error(`deploy:latest: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
