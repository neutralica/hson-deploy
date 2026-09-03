#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { with_deployment_lock } from "./deployment-lock.mjs";

export const MANAGED_SOURCE_SUBMODULES = Object.freeze(["hson-live", "hson-demo2"]);

function run_command(command, arguments_, options = {}) {
  return execFileSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  }).trim();
}

function git(run, cwd, arguments_) {
  return run("git", arguments_, { cwd });
}

function require_git_checkout(run, directory, label) {
  if (!existsSync(directory)) throw new Error(`${label} Git checkout is missing at ${directory}.`);
  let inside;
  try { inside = git(run, directory, ["rev-parse", "--is-inside-work-tree"]); }
  catch (cause) { throw new Error(`${label} is not a valid Git checkout at ${directory}.`, { cause }); }
  if (inside !== "true") throw new Error(`${label} is not a valid Git checkout at ${directory}.`);
}

function require_clean_owning_source(run, directory, label) {
  const status = git(run, directory, ["status", "--porcelain", "--untracked-files=no"]);
  if (status !== "") {
    throw new Error(`${label} has uncommitted tracked source changes; commit or discard owning-repository changes first.\n${status}`);
  }
}

function require_clean_nested_checkout(run, directory, label) {
  const status = git(run, directory, ["status", "--porcelain"]);
  if (status !== "") throw new Error(`${label} nested checkout is dirty; source changes must be handled in the owning repository.\n${status}`);
}

function committed_gitlink(run, deploymentRoot, name) {
  const entry = git(run, deploymentRoot, ["ls-tree", "HEAD", "--", name]);
  const revision = /^160000 commit ([0-9a-f]{40})\t/.exec(entry)?.[1];
  if (revision === undefined) throw new Error(`${name} is not a committed hson-deploy gitlink.`);
  return revision;
}

export function synchronize_source_gitlinks(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const owningRoot = resolve(options.owningRoot ?? resolve(deploymentRoot, ".."));
  const run = options.run ?? run_command;
  const plans = [];

  for (const name of MANAGED_SOURCE_SUBMODULES) {
    const owningDirectory = resolve(owningRoot, name);
    const nestedDirectory = resolve(deploymentRoot, name);
    require_git_checkout(run, owningDirectory, `${name} owning repository`);
    require_clean_owning_source(run, owningDirectory, name);
    require_git_checkout(run, nestedDirectory, `${name} nested submodule`);
    require_clean_nested_checkout(run, nestedDirectory, name);

    const previous = committed_gitlink(run, deploymentRoot, name);
    const intended = git(run, owningDirectory, ["rev-parse", "HEAD"]);
    const nestedBefore = git(run, nestedDirectory, ["rev-parse", "HEAD"]);
    plans.push({ name, owningDirectory, nestedDirectory, previous, intended, nestedBefore });
  }

  const results = [];
  for (const plan of plans) {
    if (plan.nestedBefore !== plan.intended) {
      git(run, plan.nestedDirectory, ["fetch", "--no-tags", plan.owningDirectory, plan.intended]);
      git(run, plan.nestedDirectory, ["checkout", "--detach", plan.intended]);
    }

    const nestedAfter = git(run, plan.nestedDirectory, ["rev-parse", "HEAD"]);
    if (nestedAfter !== plan.intended) throw new Error(`${plan.name} synchronization failed: nested HEAD ${nestedAfter} does not equal owning HEAD ${plan.intended}.`);
    require_clean_nested_checkout(run, plan.nestedDirectory, plan.name);
    results.push(Object.freeze({ name: plan.name, previous: plan.previous, intended: plan.intended, changed: plan.previous !== plan.intended }));
  }

  return Object.freeze(results);
}

export function print_source_gitlink_results(results, write = (text) => process.stdout.write(text)) {
  for (const result of results) write(`${result.name}: ${result.previous} -> ${result.intended}${result.changed ? "" : " (unchanged)"}\n`);
  if (results.some((result) => result.changed)) write("Push owning repositories before pushing hson-deploy.\n");
}

export async function run_subs_update_command(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const lock = options.withLock ?? with_deployment_lock;
  const synchronize = options.synchronize ?? synchronize_source_gitlinks;
  return lock({ deploymentRoot, command: "subs:update" }, async () => {
    const results = await synchronize({ ...options, deploymentRoot });
    (options.printResults ?? print_source_gitlink_results)(results);
    return results;
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await run_subs_update_command(); }
  catch (error) {
    console.error(`subs:update: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
