#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve_static_artifact_verification } from "./static-deployment-authority.mjs";

export const PAGES_PROJECT = "hson-deploy";
export const PAGES_BRANCH = "main";
export const STATIC_DIRECTORY = "static-production";

function run_command(command, arguments_, options = {}) {
  return execFileSync(command, arguments_, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function parse_json(output, label) {
  const start = output.indexOf("[");
  if (start < 0) throw new Error(`${label} did not return a JSON array.`);
  try { return JSON.parse(output.slice(start)); }
  catch (cause) { throw new Error(`${label} returned invalid JSON.`, { cause }); }
}

function project_names(projects) {
  return projects.map((project) => project?.name ?? project?.project_name ?? project?.["Project Name"]).filter((name) => typeof name === "string");
}

export function execute_static_deploy(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const run = options.run ?? run_command;
  const authority = (options.resolveVerification ?? resolve_static_artifact_verification)({ deploymentRoot });
  const environment = { ...(options.environment ?? process.env), ...authority.environment };

  run("npm", ["run", "verify:static-production-artifact"], { cwd: deploymentRoot, env: environment });

  const projects = parse_json(run("wrangler", ["pages", "project", "list", "--json"], { cwd: deploymentRoot, env: environment }), "Wrangler Pages project guard");
  const names = project_names(projects);
  if (!names.includes(PAGES_PROJECT)) {
    throw new Error(`Cloudflare Pages project guard failed: expected ${PAGES_PROJECT}; available projects: ${names.join(", ") || "(none)"}.`);
  }

  const commit = authority.evidenceRoot.slice("/test-evidence/".length);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Static artifact evidence root does not identify an exact deployment commit.");
  const output = run("wrangler", [
    "pages", "deploy", STATIC_DIRECTORY,
    `--project-name=${PAGES_PROJECT}`,
    `--branch=${PAGES_BRANCH}`,
    `--commit-hash=${commit}`,
    "--commit-dirty=false",
  ], { cwd: deploymentRoot, env: environment });
  console.log(`Cloudflare Pages accepted ${STATIC_DIRECTORY}/ for project ${PAGES_PROJECT}.`);
  if (output.trim()) process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  return Object.freeze({ project: PAGES_PROJECT, branch: PAGES_BRANCH, directory: authority.artifact, commit, output });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { execute_static_deploy(); }
  catch (error) {
    console.error(`deploy:static: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
