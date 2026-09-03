import { existsSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validate_livehost_browser_configuration } from "./livehost-browser-config.mjs";
import { RUN_ID_PATTERN, validate_progressive_report_site } from "./static-report.mjs";

export const STATIC_CONFIG_FILE = "static-report-config.json";
const VISITOR_EXECUTION_MARKERS = [
  "tests.discover",
  "tests.runSelected",
  "tests.inspect",
  "tests.cancel",
  "make_remote_hosted_test_runtime",
  "HostedTestPanelRuntime",
  "HostedTestPanelAdapter",
  "run-canonical-tests.node",
  "capture:deployment-tests",
  "supervise-certification-capture",
];

async function walk(directory, root = directory) {
  const output = [];
  const state = await lstat(directory).catch(() => undefined);
  if (state === undefined || state.isSymbolicLink() || !state.isDirectory()) throw new Error(`Static production path is missing or unsafe: ${directory}.`);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (!path.startsWith(`${root}/`)) throw new Error(`Static production path escapes its artifact: ${path}.`);
    if (entry.isSymbolicLink()) throw new Error(`Static production artifact contains a symlink: ${path}.`);
    if (entry.isDirectory()) output.push(...await walk(path, root));
    else if (entry.isFile()) output.push(path);
    else throw new Error(`Static production artifact contains an unsafe entry: ${path}.`);
  }
  return output;
}

async function configuration(artifact) {
  const path = resolve(artifact, STATIC_CONFIG_FILE);
  let value;
  try {
    const state = await lstat(path);
    if (state.isSymbolicLink() || !state.isFile() || state.size > 64 * 1024) throw new Error("unsafe configuration file");
    value = JSON.parse(await readFile(path, "utf8"));
  }
  catch (cause) { throw new Error(`Static production configuration is missing or malformed at ${path}.`, { cause }); }
  if (value?.schemaVersion !== 1 || typeof value.testEvidenceRoot !== "string" || typeof value.runId !== "string" || typeof value.liveHostWebSocketOrigin !== "string") {
    throw new Error("Static production configuration has an invalid shape.");
  }
  if (!RUN_ID_PATTERN.test(value.runId) || value.testEvidenceRoot !== `/test-evidence/${value.runId}`) throw new Error("Static production configuration does not identify one immutable report root.");
  return Object.freeze(value);
}

export async function resolve_embedded_livehost_browser_configuration(options = {}) {
  const artifact = resolve(options.artifact ?? resolve(import.meta.dirname, "..", "static-production"));
  const config = await configuration(artifact);
  return validate_livehost_browser_configuration({ VITE_LIVEHOST_WS_URL: config.liveHostWebSocketOrigin });
}

export async function verify_static_production_artifact(options = {}) {
  const artifact = resolve(options.artifact ?? resolve(import.meta.dirname, "..", "static-production"));
  if (!existsSync(resolve(artifact, "index.html"))) throw new Error("Static production artifact is missing index.html.");
  const files = await walk(artifact);
  const config = await configuration(artifact);
  const liveHost = validate_livehost_browser_configuration({ VITE_LIVEHOST_WS_URL: config.liveHostWebSocketOrigin });
  if (options.requireSecurePublic === true && (liveHost.localSimulation || !config.liveHostWebSocketOrigin.startsWith("wss://"))) {
    throw new Error("Static deployment requires a public wss:// LiveHost origin.");
  }

  const evidenceDirectory = resolve(artifact, config.testEvidenceRoot.slice(1));
  const evidenceParent = resolve(artifact, "test-evidence");
  const roots = await readdir(evidenceParent, { withFileTypes: true }).catch(() => []);
  if (roots.length !== 1 || !roots[0].isDirectory() || roots[0].isSymbolicLink() || roots[0].name !== config.runId) {
    throw new Error("Static production artifact must contain exactly its configured immutable report root.");
  }
  const report = await validate_progressive_report_site({ runId: config.runId, site: evidenceDirectory });

  const sourcePaths = files.filter((path) => /\.(?:html|js|css)$/.test(path));
  const sources = await Promise.all(sourcePaths.map(async (path) => {
    const state = await lstat(path);
    if (state.size > 16 * 1024 * 1024) throw new Error(`Static application source exceeds the byte limit: ${path}.`);
    return readFile(path, "utf8");
  }));
  if (!sources.some((source) => source.includes(config.testEvidenceRoot))) throw new Error("Static application does not embed the configured immutable report root.");
  if (!sources.some((source) => source.includes(config.liveHostWebSocketOrigin))) throw new Error("Static application does not embed the configured LiveHost origin.");
  const otherRoots = sources.join("\n").match(/\/test-evidence\/[0-9a-f-]{36}/gi) ?? [];
  if (otherRoots.some((root) => root !== config.testEvidenceRoot)) throw new Error("Static application contains a different report root.");
  if (sources.some((source) => /\/test-evidence\/(?:latest|current)(?:[/?#"']|$)/i.test(source))) throw new Error("Static application contains a mutable report root.");

  const frozenSources = sources.filter((source) => source.includes("data-frozen-panel-state") || source.includes("frozen-test-panel"));
  if (frozenSources.length === 0) throw new Error("Static application is missing the frozen Tests explorer.");
  for (const marker of VISITOR_EXECUTION_MARKERS) {
    if (frozenSources.some((source) => source.includes(marker))) throw new Error(`Frozen Tests explorer retains visitor execution capability: ${marker}.`);
  }
  return Object.freeze({ artifact, evidenceRoot: config.testEvidenceRoot, runId: config.runId, reportStatus: report.status, liveHostOrigin: liveHost.origin, files: files.length, referencedReportFiles: report.referencedFiles, visitorExecutionAbsent: true });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verify_static_production_artifact({ requireSecurePublic: process.argv.includes("--public") });
    console.log(`Static production artifact contains immutable ${result.evidenceRoot} (${result.reportStatus}); frozen visitor execution is absent.`);
  } catch (error) {
    console.error(`verify:static-production-artifact: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
