import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { make_direct_report, FIXTURE_RUN_ID } from "./static-report-fixture.test-helper.mjs";
import { verify_static_production_artifact } from "./verify-static-production-artifact.mjs";

async function artifact(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "hson-static-verifier-"));
  const reports = join(root, "reports");
  const report = await make_direct_report(reports, { status: options.status ?? "pass" });
  const artifact = join(root, "artifact");
  const evidence = join(artifact, "test-evidence", FIXTURE_RUN_ID);
  await mkdir(join(artifact, "assets"), { recursive: true });
  await mkdir(join(artifact, "test-evidence"), { recursive: true });
  const { cp } = await import("node:fs/promises");
  await cp(report.site, evidence, { recursive: true });
  const origin = options.origin ?? "wss://runtime.example";
  await writeFile(join(artifact, "index.html"), `<script src="/assets/app.js"></script>`);
  await writeFile(join(artifact, "assets", "app.js"), `const root="/test-evidence/${FIXTURE_RUN_ID}";const livehost=${JSON.stringify(origin)};const panel="frozen-test-panel data-frozen-panel-state ${options.marker ?? ""}";`);
  await writeFile(join(artifact, "static-report-config.json"), `${JSON.stringify({ schemaVersion: 1, testEvidenceRoot: `/test-evidence/${FIXTURE_RUN_ID}`, runId: FIXTURE_RUN_ID, liveHostWebSocketOrigin: origin })}\n`);
  return { artifact, evidence };
}

test("artifact validation proves immutable references and absent visitor execution", async () => {
  const fixture = await artifact({ status: "fail" });
  const result = await verify_static_production_artifact({ artifact: fixture.artifact, requireSecurePublic: true });
  assert.equal(result.reportStatus, "fail");
  assert.equal(result.evidenceRoot, `/test-evidence/${FIXTURE_RUN_ID}`);
  assert.equal(result.visitorExecutionAbsent, true);
});

test("public artifact validation requires secure runtime configuration", async () => {
  const fixture = await artifact({ origin: "ws://127.0.0.1:8787" });
  await assert.rejects(verify_static_production_artifact({ artifact: fixture.artifact, requireSecurePublic: true }), /public wss:\/\//);
  await assert.doesNotReject(verify_static_production_artifact({ artifact: fixture.artifact, requireSecurePublic: false }));
});

test("malformed references, symlinks, and visitor execution markers fail closed", async () => {
  const malformed = await artifact();
  await writeFile(join(malformed.evidence, "index.json"), "{}\n");
  await assert.rejects(verify_static_production_artifact({ artifact: malformed.artifact }), /runId does not match/);

  const linked = await artifact();
  await symlink(join(linked.artifact, "index.html"), join(linked.artifact, "linked.html"));
  await assert.rejects(verify_static_production_artifact({ artifact: linked.artifact }), /contains a symlink/);

  const executable = await artifact({ marker: "tests.runSelected" });
  await assert.rejects(verify_static_production_artifact({ artifact: executable.artifact }), /visitor execution capability/);
});
