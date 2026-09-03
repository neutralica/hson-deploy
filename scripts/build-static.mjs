#!/usr/bin/env node

import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validate_livehost_browser_configuration } from "./livehost-browser-config.mjs";
import { validate_direct_report, validate_run_id } from "./static-report.mjs";
import { verify_static_production_artifact } from "./verify-static-production-artifact.mjs";

export const STATIC_CONFIG_FILE = "static-report-config.json";

function run_command(command, arguments_, options = {}) {
  return execFileSync(command, arguments_, { cwd: options.cwd, env: options.env, encoding: "utf8", stdio: "inherit" });
}

function report_roots(deploymentRoot, environment) {
  const configured = environment.HSON_TEST_REPORTS_DIRECTORY?.trim();
  if (configured) return [resolve(configured)];
  return [resolve(deploymentRoot, "..", "hson-demo2", ".test-reports"), resolve(deploymentRoot, "hson-demo2", ".test-reports")];
}

async function current_run_id(root) {
  const path = resolve(root, "current.json");
  let pointer;
  try { pointer = JSON.parse(await readFile(path, "utf8")); }
  catch (cause) { throw new Error(`Direct report pointer is missing or malformed at ${path}.`, { cause }); }
  const runId = validate_run_id(pointer?.runId, "current report run ID");
  if (pointer.path !== `${runId}/site`) throw new Error(`Direct report pointer has an unexpected site path at ${path}.`);
  return runId;
}

export async function resolve_direct_report(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const environment = options.environment ?? process.env;
  const roots = options.reportRoots?.map((root) => resolve(root)) ?? report_roots(deploymentRoot, environment);
  if (roots.length === 0) throw new Error("No direct report roots are configured.");
  if (options.runId !== undefined) {
    const runId = validate_run_id(options.runId);
    for (const root of roots) if (existsSync(resolve(root, runId))) return validate_direct_report({ runId, runDirectory: resolve(root, runId) });
    throw new Error(`Direct report ${runId} was not found in: ${roots.join(", ")}.`);
  }
  let lastError;
  for (const root of roots) {
    try {
      const runId = await current_run_id(root);
      return await validate_direct_report({ runId, runDirectory: resolve(root, runId) });
    } catch (cause) { lastError = cause; }
  }
  throw new Error(`No valid current direct report was found.${lastError instanceof Error ? ` ${lastError.message}` : ""}`, { cause: lastError });
}

async function atomic_replace(candidate, destination) {
  const backup = `${destination}.previous-${process.pid}-${Date.now()}`;
  const hadDestination = existsSync(destination);
  if (hadDestination) await rename(destination, backup);
  try { await rename(candidate, destination); }
  catch (cause) {
    if (hadDestination) await rename(backup, destination);
    throw cause;
  }
  if (hadDestination) await rm(backup, { recursive: true, force: true });
}

export async function build_static(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const environment = options.environment ?? process.env;
  const liveHost = validate_livehost_browser_configuration(environment);
  const report = await (options.resolveReport ?? resolve_direct_report)({ deploymentRoot, environment, runId: options.runId, reportRoots: options.reportRoots });
  const evidenceRoot = `/test-evidence/${report.runId}`;
  const temporary = await mkdtemp(resolve(deploymentRoot, ".static-production-build-"));
  const candidate = resolve(temporary, "artifact");
  const destination = resolve(options.artifact ?? resolve(deploymentRoot, "static-production"));
  const run = options.run ?? run_command;
  try {
    await mkdir(candidate, { recursive: true });
    run("npm", ["-w", "hson-demo2", "run", "build", "--", "--outDir", candidate, "--emptyOutDir"], {
      cwd: deploymentRoot,
      env: { ...environment, VITE_TEST_EVIDENCE_ROOT: evidenceRoot, VITE_LIVEHOST_WS_URL: liveHost.configured },
    });
    if (!existsSync(resolve(candidate, "index.html"))) throw new Error("Application build did not produce index.html.");
    const publicReport = resolve(candidate, evidenceRoot.slice(1));
    await mkdir(dirname(publicReport), { recursive: true });
    await cp(report.site, publicReport, { recursive: true, force: false, errorOnExist: true });
    await writeFile(resolve(candidate, STATIC_CONFIG_FILE), `${JSON.stringify({ schemaVersion: 1, testEvidenceRoot: evidenceRoot, runId: report.runId, liveHostWebSocketOrigin: liveHost.configured }, null, 2)}\n`);
    const verification = await verify_static_production_artifact({ artifact: candidate, requireSecurePublic: false });
    await atomic_replace(candidate, destination);
    return Object.freeze({ artifact: destination, evidenceRoot, report, verification });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function parse_build_static_arguments(arguments_) {
  if (arguments_.length === 0) return Object.freeze({});
  if (arguments_.length === 2 && arguments_[0] === "--run") return Object.freeze({ runId: validate_run_id(arguments_[1]) });
  throw new Error("Usage: npm run build:static -- [--run <run-id>]");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await build_static(parse_build_static_arguments(process.argv.slice(2)));
    console.log(`Static production built from direct report ${result.report.runId} (${result.report.status}) at ${result.artifact}.`);
  } catch (error) {
    console.error(`build:static: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
