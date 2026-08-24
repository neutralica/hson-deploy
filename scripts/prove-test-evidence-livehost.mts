import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { start_node_application_host } from "hson-live/livehost/node";
import type { LiveHostApplication } from "hson-live/livehost";

const candidateArgument = process.argv[2];
if (!candidateArgument || process.argv.length !== 3) {
  console.error("usage: npm run prove:test-evidence:livehost -- <materialization-candidate>");
  process.exitCode = 2;
} else {
  const candidate = resolve(candidateArgument);
  const acceptance = JSON.parse(await readFile(join(candidate, "accepted.json"), "utf8"));
  assert.equal(acceptance.accepted, true, "TEST_EVIDENCE_CANDIDATE_NOT_ACCEPTED");
  const evidenceRoot = join(candidate, "site", acceptance.evidenceRoot);
  const index = JSON.parse(await readFile(join(evidenceRoot, "index.json"), "utf8"));
  const caseArtifacts = index.suites.flatMap((suite: any) => suite.cases.map((item: any) => item.evidence).filter((entry: any) => entry.available));
  const suiteArtifacts = index.suites.map((suite: any) => suite.evidence).filter((entry: any) => entry.available);
  assert.ok(caseArtifacts.length > 0 && suiteArtifacts.length > 0, "TEST_EVIDENCE_LAZY_ARTIFACTS_MISSING");
  const largestCase = caseArtifacts.reduce((largest: any, entry: any) => entry.rawBytes > largest.rawBytes ? entry : largest);
  const ordinaryCase = [...caseArtifacts].sort((a: any, b: any) => a.rawBytes - b.rawBytes)[Math.floor(caseArtifacts.length / 2)];
  const selected = ["index.json", ordinaryCase.path, largestCase.path, suiteArtifacts[0].path]
    .filter((path, index_, paths) => paths.indexOf(path) === index_);
  let testExecutions = 0;
  let disposed = 0;
  const application: LiveHostApplication = Object.freeze({
    name: "frozen-evidence-delivery-proof",
    requests: Object.freeze(selected.map((path) => Object.freeze({
      method: "GET",
      path: `/${acceptance.evidenceRoot}/${path}`,
      async handle() {
        return new Response(await readFile(join(evidenceRoot, path)), { headers: { "content-type": "application/json; charset=utf-8" } });
      },
    }))),
    dispose() { disposed += 1; },
  });
  const host = await start_node_application_host({ host: "127.0.0.1", port: 0, applications: [application] });
  const served: any[] = [];
  try {
    for (const path of selected) {
      const disk = await readFile(join(evidenceRoot, path));
      const response = await fetch(`${host.httpUrl}/${acceptance.evidenceRoot}/${path}`);
      const http = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, 200, `TEST_EVIDENCE_HTTP_STATUS:${path}`);
      assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8", `TEST_EVIDENCE_HTTP_CONTENT_TYPE:${path}`);
      assert.deepEqual(http, disk, `TEST_EVIDENCE_HTTP_BYTE_PARITY:${path}`);
      served.push({ path: `/${acceptance.evidenceRoot}/${path}`, rawBytes: disk.byteLength, byteParity: true, contentType: response.headers.get("content-type") });
    }
    assert.equal(testExecutions, 0, "TEST_EVIDENCE_HTTP_TRIGGERED_EXECUTION");
  } finally {
    await host.dispose();
  }
  assert.equal(disposed, 1, "TEST_EVIDENCE_LIVEHOST_CLEANUP");
  console.log(JSON.stringify({ served, testExecutions, cleanup: { applicationDisposed: disposed, liveHostDisposed: true } }, null, 2));
}
