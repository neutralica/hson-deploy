import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { start_node_application_host } from "hson-live/livehost/node";
import type { LiveHostApplication } from "hson-live/livehost";
import { materialize_test_evidence } from "./materializer.mjs";
import { make_capture } from "./test-fixture.mjs";

test("existing LiveHost exact routes serve immutable JSON bytes without test execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "hson-livehost-evidence-"));
  const fixture = await make_capture(root);
  const materialized = await materialize_test_evidence(fixture.candidate, { workRoot: join(root, "work"), verifyRevisions: false, materializedAt: "fixed" });
  const caseRecords = materialized.index.suites.flatMap((suite: any) => suite.cases.map((item: any) => item.evidence).filter((entry: any) => entry.available));
  const suiteRecord = materialized.index.suites.map((suite: any) => suite.evidence).find((entry: any) => entry.available);
  const largestCase = caseRecords.reduce((largest: any, entry: any) => entry.rawBytes > largest.rawBytes ? entry : largest);
  const selected = ["index.json", caseRecords[0].path, largestCase.path, suiteRecord.path].filter((path, index, values) => values.indexOf(path) === index);
  let testExecutions = 0;
  let disposed = 0;
  const application: LiveHostApplication = Object.freeze({
    name: "frozen-evidence-proof",
    requests: Object.freeze(selected.map((path) => Object.freeze({
      method: "GET",
      path: `/${materialized.publicRoot}/${path}`,
      async handle() {
        const bytes = await readFile(join(materialized.evidenceRoot, path));
        return new Response(bytes, { headers: { "content-type": "application/json; charset=utf-8" } });
      },
    }))),
    dispose() { disposed += 1; },
  });
  const host = await start_node_application_host({ host: "127.0.0.1", port: 0, applications: [application] });
  try {
    for (const path of selected) {
      const response = await fetch(`${host.httpUrl}/${materialized.publicRoot}/${path}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(join(materialized.evidenceRoot, path)));
    }
    assert.equal(testExecutions, 0);
  } finally {
    await host.dispose();
  }
  assert.equal(disposed, 1);
  assert.equal(testExecutions, 0);
});
