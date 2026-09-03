import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { build_static, resolve_direct_report } from "./build-static.mjs";
import { FIXTURE_RUN_ID, make_direct_report } from "./static-report-fixture.test-helper.mjs";

const PUBLIC_ENV = { VITE_LIVEHOST_WS_URL: "wss://runtime.example" };

function application_builder(calls) {
  return (command, arguments_, options) => {
    calls.push({ command, arguments_, options });
    const outIndex = arguments_.indexOf("--outDir") + 1;
    const output = arguments_[outIndex];
    mkdirSync(join(output, "assets"), { recursive: true });
    writeFileSync(join(output, "index.html"), `<script src="/assets/app.js"></script>`);
    writeFileSync(join(output, "assets", "app.js"), `const evidence=${JSON.stringify(options.env.VITE_TEST_EVIDENCE_ROOT)};const livehost=${JSON.stringify(options.env.VITE_LIVEHOST_WS_URL)};const panel="frozen-test-panel data-frozen-panel-state";`);
    return "";
  };
}

async function workspace(status = "pass") {
  const deploymentRoot = await mkdtemp(join(tmpdir(), "hson-build-static-"));
  const reports = join(deploymentRoot, "reports");
  const report = await make_direct_report(reports, { status });
  return { deploymentRoot, reports, report };
}

test("explicit run selection and current.json resolve the same direct report", async () => {
  const fixture = await workspace();
  await writeFile(join(fixture.reports, "current.json"), `${JSON.stringify({ runId: FIXTURE_RUN_ID, path: `${FIXTURE_RUN_ID}/site` })}\n`);
  assert.equal((await resolve_direct_report({ deploymentRoot: fixture.deploymentRoot, reportRoots: [fixture.reports], runId: FIXTURE_RUN_ID })).runId, FIXTURE_RUN_ID);
  assert.equal((await resolve_direct_report({ deploymentRoot: fixture.deploymentRoot, reportRoots: [fixture.reports] })).runId, FIXTURE_RUN_ID);
});

test("missing and malformed reports are rejected before application build", async () => {
  const fixture = await workspace();
  await assert.rejects(resolve_direct_report({ deploymentRoot: fixture.deploymentRoot, reportRoots: [fixture.reports], runId: "22222222-2222-4222-8222-222222222222" }), /was not found/);
  await writeFile(join(fixture.report.site, "index.json"), "{}\n");
  const calls = [];
  await assert.rejects(build_static({ deploymentRoot: fixture.deploymentRoot, reportRoots: [fixture.reports], runId: FIXTURE_RUN_ID, environment: PUBLIC_ENV, run: application_builder(calls) }), /runId does not match/);
  assert.equal(calls.length, 0);
});

for (const status of ["fail", "cancelled", "error"]) {
  test(`a structurally valid ${status} report builds and remains ${status} evidence`, async () => {
    const fixture = await workspace(status);
    const calls = [];
    const result = await build_static({ deploymentRoot: fixture.deploymentRoot, reportRoots: [fixture.reports], runId: FIXTURE_RUN_ID, environment: PUBLIC_ENV, run: application_builder(calls) });
    assert.equal(result.report.status, status);
    assert.equal(result.verification.reportStatus, status);
    assert.equal(result.evidenceRoot, `/test-evidence/${FIXTURE_RUN_ID}`);
    assert.equal(existsSync(join(result.artifact, "test-evidence", FIXTURE_RUN_ID, "index.json")), true);
    assert.match(readFileSync(join(result.artifact, "assets", "app.js"), "utf8"), new RegExp(`/test-evidence/${FIXTURE_RUN_ID}`));
    assert.deepEqual(calls.map(({ command, arguments_ }) => `${command} ${arguments_.slice(0, 4).join(" ")}`), ["npm -w hson-demo2 run build"]);
    assert.doesNotMatch(calls[0].arguments_.join(" "), /test:|certif|capture|submodule|subs:update/);
  });
}

test("unsafe report symlinks are rejected", async () => {
  const fixture = await workspace();
  await symlink(join(fixture.report.site, "cases", "observed-case.json"), join(fixture.report.site, "cases", "linked.json"));
  await assert.rejects(resolve_direct_report({ deploymentRoot: fixture.deploymentRoot, reportRoots: [fixture.reports], runId: FIXTURE_RUN_ID }), /unsafe entry/);
});

test("unsafe report references are rejected", async () => {
  const fixture = await workspace();
  const indexPath = join(fixture.report.site, "index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  index.categories[0].file = "../run.json";
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  await assert.rejects(resolve_direct_report({ deploymentRoot: fixture.deploymentRoot, reportRoots: [fixture.reports], runId: FIXTURE_RUN_ID }), /Unsafe static report path/);
});

test("successful build atomically replaces the previous artifact and removes owned temporary state", async () => {
  const fixture = await workspace();
  const artifact = join(fixture.deploymentRoot, "static-production");
  mkdirSync(artifact, { recursive: true });
  writeFileSync(join(artifact, "stale.txt"), "old");
  await build_static({ deploymentRoot: fixture.deploymentRoot, artifact, reportRoots: [fixture.reports], runId: FIXTURE_RUN_ID, environment: PUBLIC_ENV, run: application_builder([]) });
  assert.equal(existsSync(join(artifact, "stale.txt")), false);
  assert.equal(existsSync(join(artifact, "index.html")), true);
  assert.deepEqual((await readdir(fixture.deploymentRoot)).filter((name) => name.startsWith(".static-production-build-") || name.startsWith("static-production.previous-")), []);
});

test("a failed application build preserves the existing artifact", async () => {
  const fixture = await workspace();
  const artifact = join(fixture.deploymentRoot, "static-production");
  mkdirSync(artifact, { recursive: true });
  writeFileSync(join(artifact, "owned.txt"), "preserve");
  await assert.rejects(build_static({ deploymentRoot: fixture.deploymentRoot, artifact, reportRoots: [fixture.reports], runId: FIXTURE_RUN_ID, environment: PUBLIC_ENV, run() { throw new Error("build failed"); } }), /build failed/);
  assert.equal(readFileSync(join(artifact, "owned.txt"), "utf8"), "preserve");
});
