import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const FIXTURE_RUN_ID = "11111111-1111-4111-8111-111111111111";

export async function make_direct_report(root, options = {}) {
  const runId = options.runId ?? FIXTURE_RUN_ID;
  const status = options.status ?? "pass";
  const runDirectory = join(root, runId);
  const site = join(runDirectory, "site");
  await Promise.all(["categories", "suites", "cases", "artifacts"].map((folder) => mkdir(join(site, folder), { recursive: true })));
  const totals = { pass: status === "pass" ? 1 : 0, fail: status === "fail" ? 1 : 0, skip: 0, unsupported: 0, cancelled: status === "cancelled" ? 1 : 0, error: status === "error" ? 1 : 0, cases: 1, suites: 1 };
  const timing = { startedAt: "2026-09-03T00:00:00.000Z", endedAt: "2026-09-03T00:00:01.000Z", durationMs: 1000 };
  const caseReference = { id: "observed case", title: "Observed case", status, ...timing, file: "cases/observed-case.json" };
  const suiteSummary = { id: "unit/observed", title: "Observed suite", category: "unit", status, ...timing, totals, file: "suites/unit-observed.json" };
  await writeFile(join(site, "index.json"), `${JSON.stringify({ runId, status, ...timing, repositories: [], totals, diagnostics: [], artifacts: [], categories: [{ id: "unit", file: "categories/unit.json", status, totals }], suites: [{ id: "unit/observed", file: "suites/unit-observed.json" }] }, null, 2)}\n`);
  await writeFile(join(site, "categories", "unit.json"), `${JSON.stringify({ id: "unit", suites: [suiteSummary] }, null, 2)}\n`);
  await writeFile(join(site, "suites", "unit-observed.json"), `${JSON.stringify({ id: "unit/observed", title: "Observed suite", category: "unit", status, ...timing, totals, diagnostics: [], artifacts: [], cases: [caseReference] }, null, 2)}\n`);
  await writeFile(join(site, "cases", "observed-case.json"), `${JSON.stringify({ id: "observed case", title: "Observed case", status, ...timing, diagnostics: [], artifacts: [] }, null, 2)}\n`);
  await writeFile(join(runDirectory, "run.json"), `${JSON.stringify({ id: runId, status, ...timing, repositories: [{ name: "hson-demo2", revision: "a".repeat(40), dirty: true }], selection: { profile: null, ids: ["unit/observed"] }, totals, diagnostics: [], artifacts: [], suites: [] }, null, 2)}\n`);
  return { root, runId, runDirectory, site, status };
}
