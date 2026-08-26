import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const candidate = process.env.HSON_CERTIFICATION_CAPTURE_CANDIDATE;
const captureId = process.env.HSON_CERTIFICATION_CAPTURE_ID;
const mode = process.env.CERTIFICATION_COMPLETION_FIXTURE_MODE;
const deployment = JSON.parse(process.env.CERTIFICATION_COMPLETION_FIXTURE_SOURCE ?? "null");
if (!candidate || !captureId || !mode || deployment === null) throw new Error("CERTIFICATION_COMPLETION_FIXTURE_INVALID");

mkdirSync(dirname(candidate), { recursive: true });
writeFileSync(`${candidate}.pid`, String(process.pid));
if (mode === "premature-exit") process.exit(7);

const capture = join(candidate, "capture");
mkdirSync(capture, { recursive: true });
const atomic = (path, value) => {
  const temporary = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, path);
};
const selected = ["certification/completion-fixture"];
const evidence = {
  id: "fixture:stdout", sequence: 1, timestamp: 1, executorId: "fixture",
  kind: "stdout", name: "stdout", content: "fixture passed\n", truncated: false,
  knownBytes: 15, reference: null, mediaType: "text/plain",
};
const report = {
  run: { id: "completion-fixture-run", status: mode.startsWith("invalid-report") ? "failed" : "passed" },
  summary: { cases: 0, pass: 0, fail: mode.startsWith("invalid-report") ? 1 : 0, skip: 0 },
  plan: { selectionIds: selected },
  suiteRuns: [{
    id: selected[0], executionShape: "certification-aggregate", status: mode.startsWith("invalid-report") ? "fail" : "pass",
    sourceRef: "node-command:completion-fixture", evidence: [evidence], evidenceRefs: [evidence.id], cases: [],
  }],
  error: null,
};
const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
const cleanup = {
  captureId,
  clientSockets: { total: mode.startsWith("invalid-cleanup") ? 1 : 0, hostedTests: { total: 0 }, towl: 0, circuitVerification: 0 },
  browser: { activeProcesses: 0, activeJourneys: 0, retainedArtifactRoots: 0, forcedTerminations: 0 },
};
const terminalStatus = mode.startsWith("fail") ? "failed" : "passed";
const terminalCaptureId = mode.startsWith("stale-terminal") ? crypto.randomUUID() : captureId;

atomic(join(candidate, "capture-preflight.json"), { captureId, status: "passed", deployment });
atomic(join(capture, "certification.json"), report);
atomic(join(capture, "capture-metadata.json"), {
  captureId,
  deployment,
  selectedStages: ["certification"],
  selection: { certification: { idCount: selected.length, ids: selected } },
  runs: { certification: {
    runId: report.run.id,
    attemptId: `${report.run.id}:attempt:1`,
    reportHostId: "fixture-host",
    reportRev: 1,
    clientAppliedReportRev: 1,
    reportFile: "certification.json",
    selectionCount: selected.length,
    rawBytes: reportBytes.byteLength,
    terminalStatus: report.run.status,
  } },
});
atomic(join(capture, "capture-cleanup.json"), cleanup);
if (terminalStatus === "failed") atomic(join(candidate, "capture-diagnostics.json"), { captureId, failedStage: "fixture", error: { message: "intentional fixture failure" } });
atomic(join(capture, "capture-terminal.json"), {
  schemaVersion: 1,
  kind: "hson-deployment-capture-terminal",
  captureId: terminalCaptureId,
  status: terminalStatus,
  completedAt: new Date().toISOString(),
  lastCheckpoint: "cleanup-persisted",
  selectedStages: ["certification"],
  deployment,
  sourceRevalidated: true,
  externalOwnership: { stateChildren: 0, clientSockets: 0, browserProcesses: 0, browserJourneys: 0 },
});

if (mode.endsWith("linger")) {
  process.on("SIGTERM", () => undefined);
  setInterval(() => undefined, 60_000);
}
