import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { arch, platform, version as nodeVersion } from "node:process";
import { basename, dirname, join, resolve } from "node:path";
import WebSocket from "ws";
import type { BrowserWebSocketConstructor } from "../hson-demo2/src/app/demos/tests/hosted-client/browser-websocket-socket";
import { make_hosted_test_panel_adapter, type HostedTestPanelSink } from "../hson-demo2/src/app/demos/tests/panel/hosted-test-panel-adapter";
import { make_remote_hosted_test_runtime } from "../hson-demo2/src/app/demos/tests/panel/hosted-test-panel-runtime";
import { hosted_test_projection_summary } from "../hson-demo2/src/app/demos/tests/panel/hosted-test-report-summary";
import type { HostedTestReport } from "../hson-demo2/src/shared/hosted-tests/hosted-test-report.types";
import type { TestExecutorDiscovery } from "../hson-demo2/src/shared/testing/test-discovery-contract";
import { start_hosted_test_server } from "../hson-demo2/tests/harness/runtimes/node/server/hosted-test-server";

const ROOT = resolve(import.meta.dirname, "..");
const DEMO = join(ROOT, "hson-demo2");
type Name = "semantic" | "browser" | "certification";
type Selection = Readonly<{ name: Name; ids: readonly string[] }>;

function git(args: readonly string[], cwd = ROOT): string { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function state() {
  if (git(["status", "--porcelain"]) !== "") throw new Error("DEPLOYMENT_CAPTURE_PARENT_DIRTY");
  const links: Record<string, string> = {};
  for (const path of ["hson-demo2", "hson-live", "intrastructure"]) {
    const expected = git(["ls-tree", "HEAD", path]).split(/\s+/)[2];
    const actual = git(["rev-parse", "HEAD"], join(ROOT, path));
    if (expected !== actual || git(["status", "--porcelain"], join(ROOT, path)) !== "") throw new Error(`DEPLOYMENT_CAPTURE_SUBMODULE_INVALID:${path}`);
    links[path] = actual;
  }
  return Object.freeze({ hsonDeployCommit: git(["rev-parse", "HEAD"]), hsonDemo2Gitlink: links["hson-demo2"], hsonLiveGitlink: links["hson-live"], intrastructureGitlink: links.intrastructure });
}
function unique(ids: readonly string[], name: string) { if (new Set(ids).size !== ids.length) throw new Error(`DEPLOYMENT_CAPTURE_DUPLICATE:${name}`); return Object.freeze([...ids]); }
export function derive_selections(discovery: TestExecutorDiscovery): readonly Selection[] {
  const suites = new Map(discovery.catalog.suites.map((suite) => [suite.id, suite]));
  if (suites.size !== discovery.catalog.suites.length) throw new Error("DEPLOYMENT_CAPTURE_DUPLICATE_SUITE");
  const caseIds = (shape: string) => discovery.catalog.tests.filter((test) => suites.get(test.suiteId)?.executionShape === shape).map((test) => test.id);
  const semantic = [...caseIds("cases"), ...discovery.catalog.suites.filter((suite) => suite.executionShape === "opaque-aggregate").map((suite) => suite.id)];
  const browser = caseIds("browser-journeys");
  const certification = discovery.catalog.suites.filter((suite) => suite.executionShape === "certification-aggregate" && !suite.requirements.includes("dynamic-generated")).map((suite) => {
    if (!suite.sourceRef?.startsWith("node-command:")) throw new Error(`DEPLOYMENT_CAPTURE_CERTIFICATION_SOURCE:${suite.id}`); return suite.id;
  });
  if (!semantic.length || !browser.length || !certification.length) throw new Error("DEPLOYMENT_CAPTURE_EMPTY_SELECTION");
  return Object.freeze([Object.freeze({ name: "semantic" as const, ids: unique(semantic, "semantic") }), Object.freeze({ name: "browser" as const, ids: unique(browser, "browser") }), Object.freeze({ name: "certification" as const, ids: unique(certification, "certification") })]);
}
async function atomic(path: string, value: unknown) { const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); const temp = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`); await writeFile(temp, bytes, { flag: "wx" }); JSON.parse(await readFile(temp, "utf8")); await rename(temp, path); return bytes.byteLength; }
function sink(): HostedTestPanelSink { return Object.freeze({ reset() {}, ingest() {}, showInfrastructureError(message) { throw new Error(message); } }); }
function validate(name: Name, intended: readonly string[], report: HostedTestReport, result: any) {
  assert.equal(report.run.status, "passed"); assert.equal(result.ok, true); assert.equal(result.runId, report.run.id); assert.ok(result.reportHostId); assert.ok(result.reportRev !== undefined); assert.deepEqual([...report.plan.selectionIds].sort(), [...intended].sort());
  assert.equal(report.summary.fail, 0); assert.equal(report.summary.skip, 0); assert.equal(report.suiteRuns.every((suite) => suite.status === "pass"), true);
  const summary = hosted_test_projection_summary(report);
  if (name === "semantic") { assert.equal(summary.canonical.pass, summary.canonical.total); assert.equal(summary.launchers.passedChecks, summary.launchers.declaredChecks); assert.equal(report.suiteRuns.filter((suite) => suite.executionShape === "cases").every((suite) => suite.cases.every((test) => test.diagnostic !== null)), true); }
  if (name === "browser") assert.equal(summary.browser.pass, intended.length);
  if (name === "certification") assert.equal(summary.certifications.pass, intended.length);
}
export async function capture_deployment_tests() {
  const before = state(); const candidate = join(ROOT, ".deployment-work", `capture-${Date.now().toString(36)}-${crypto.randomUUID()}`); const capture = join(candidate, "capture"); await mkdir(capture, { recursive: true }); const cwd = process.cwd(); let server: Awaited<ReturnType<typeof start_hosted_test_server>> | undefined; let runtime: ReturnType<typeof make_remote_hosted_test_runtime> | undefined; let adapter: ReturnType<typeof make_hosted_test_panel_adapter> | undefined;
  try {
    process.chdir(DEMO); server = await start_hosted_test_server({ host: "127.0.0.1", port: 0, shutdownTimeoutMs: 15_000, retainRichDiagnostics: true, authorityLifecycle: { maxTowlRooms: 8, towlIdleMs: 30_000, maxHostedReports: 8, hostedReportRetentionMs: 3_600_000, sweepIntervalMs: 30_000 } });
    runtime = make_remote_hosted_test_runtime({ url: server.url, environment: { DEV: true, PROD: false }, WebSocketConstructor: WebSocket as unknown as BrowserWebSocketConstructor, reconnectDelaysMs: [0, 5, 20] }); adapter = make_hosted_test_panel_adapter(runtime, sink()); await runtime.ready(); const selections = derive_selections(await runtime.discover()); const runs: Record<string, unknown> = {};
    for (const selection of selections) { const result = await adapter.start_selected(selection.ids); const report = adapter.capture(); if (!report) throw new Error(`DEPLOYMENT_CAPTURE_MISSING:${selection.name}`); const snapshot = JSON.parse(JSON.stringify(report)) as HostedTestReport; validate(selection.name, selection.ids, snapshot, result); const reportFile = `${selection.name}.json`; const rawBytes = await atomic(join(capture, reportFile), snapshot); runs[selection.name] = { runId: result.runId, attemptId: result.attemptId, reportHostId: result.reportHostId, reportRev: result.reportRev, reportFile, selectionCount: selection.ids.length, terminalStatus: snapshot.run.status, rawBytes }; }
    await atomic(join(capture, "capture-metadata.json"), { capturedAt: new Date().toISOString(), deployment: before, runtime: { nodeVersion, platform, architecture: arch }, runs }); return candidate;
  } finally { adapter?.dispose(); runtime?.dispose(); if (server) { await server.stop(); const browser = server.browserMetrics?.(); if (browser) { assert.equal(browser.activeProcesses, 0); assert.equal(browser.activeJourneys, 0); } } process.chdir(cwd); assert.deepEqual(state(), before); }
}
if (import.meta.url === `file://${process.argv[1]}`) capture_deployment_tests().then((candidate) => console.log(candidate));
