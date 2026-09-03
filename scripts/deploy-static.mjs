#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verify_static_production_artifact } from "./verify-static-production-artifact.mjs";

export const PAGES_PROJECT = "hson-deploy";
export const PAGES_BRANCH = "main";
export const STATIC_DIRECTORY = "static-production";

function run_command(command, arguments_, options = {}) {
  return execFileSync(command, arguments_, { cwd: options.cwd, env: options.env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
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

export async function execute_static_deploy(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const artifact = resolve(options.artifact ?? resolve(deploymentRoot, STATIC_DIRECTORY));
  const run = options.run ?? run_command;
  const environment = options.environment ?? process.env;
  const verification = await (options.verifyArtifact ?? verify_static_production_artifact)({ artifact, requireSecurePublic: true });

  const projects = parse_json(run("wrangler", ["pages", "project", "list", "--json"], { cwd: deploymentRoot, env: environment }), "Wrangler Pages project guard");
  const names = project_names(projects);
  if (!names.includes(PAGES_PROJECT)) throw new Error(`Cloudflare Pages project guard failed: expected ${PAGES_PROJECT}; available projects: ${names.join(", ") || "(none)"}.`);

  const uploadDirectory = artifact === resolve(deploymentRoot, STATIC_DIRECTORY) ? STATIC_DIRECTORY : artifact;
  const output = run("wrangler", ["pages", "deploy", uploadDirectory, `--project-name=${PAGES_PROJECT}`, `--branch=${PAGES_BRANCH}`], { cwd: deploymentRoot, env: environment });
  console.log(`Cloudflare Pages accepted the existing ${uploadDirectory} artifact for project ${PAGES_PROJECT}.`);
  if (output.trim()) process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  return Object.freeze({ project: PAGES_PROJECT, branch: PAGES_BRANCH, directory: artifact, verification, output });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await execute_static_deploy(); }
  catch (error) {
    console.error(`deploy:static: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
