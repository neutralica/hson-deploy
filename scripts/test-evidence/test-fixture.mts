import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

function lifecycle(overrides: Record<string, unknown> = {}) {
  return {
    queuedAt: 1, startedAt: 2, completedAt: 3, durationMs: 1, ms: 1,
    errors: [], lastSequence: 1, lastEventSignature: "terminal", ...overrides,
  };
}

function evidence(id: string, content: string) {
  return { id, sequence: 1, timestamp: 2, executorId: "fixture", kind: "artifact", name: id, content, truncated: false, knownBytes: Buffer.byteLength(content), reference: null, mediaType: "text/plain" };
}

function suite(id: string, shape: string, cases: any[], retained: any[] = [], suiteRefs = retained.map((entry) => entry.id)) {
  return {
    id, title: id, subject: "Hson", collections: [], provenance: { source: "fixture" }, order: 0,
    executionShape: shape, plannedExecutorId: "fixture", sourceRef: shape === "certification-aggregate" ? `node-command:${id}` : null,
    declaredChecks: null, status: "pass", ...lifecycle(),
    counts: shape === "opaque-aggregate"
      ? { declared: 1, total: 1, executed: 1, passed: 1, failed: 0, skipped: 0, unsupported: 0, cancelled: 0 }
      : { declared: cases.length, total: cases.length, executed: cases.length, passed: cases.length, failed: 0, skipped: 0, unsupported: 0, cancelled: 0 },
    evidence: retained, evidenceRefs: suiteRefs, caseOrder: cases.map((item) => item.id), runtime: "node", executorIds: ["fixture"], cases,
  };
}

function report(runId: string, selectionIds: string[], suites: any[]) {
  const cases = suites.flatMap((entry) => entry.cases);
  return {
    run: { id: runId, suite: "canonical/selected", status: "passed", startedAt: 1, completedAt: 4, timing: { runnerMs: 2, hostMs: 3 }, lastSequence: 2, lastEventSignature: "done" },
    summary: { cases: cases.length, pass: cases.length, fail: 0, skip: 0 },
    plan: { protocolVersion: 1, catalogVersion: "fixture", executorId: "fixture", selectionIds },
    suiteRuns: suites,
    error: null,
  };
}

export async function make_capture(root: string, options: { longCaseId?: boolean; certificationCount?: number } = {}) {
  const capture = join(root, "candidate", "capture");
  await mkdir(capture, { recursive: true });
  const semanticCaseId = options.longCaseId ? "x".repeat(300) : "transform/semantic-suite::case one";
  const semanticCase = { id: semanticCaseId, caseId: "case one", title: "case one", order: 0, status: "pass", ...lifecycle(), err: null, diagnostic: { trace: [1, 2], transformerArtifact: "kept" }, evidenceRefs: [], executorId: "fixture" };
  const semanticSuites = [
    suite("transform/semantic-suite", "cases", [semanticCase]),
    suite("unit/opaque-suite", "opaque-aggregate", [], [evidence("opaque:e1", "opaque output")]),
  ];
  const browserEvidence = evidence("browser:e1", "browser attachment");
  const browserCase = { id: "livedemo/browser/suite::journey", caseId: "journey", title: "journey", order: 0, status: "pass", ...lifecycle(), err: null, diagnostic: null, evidenceRefs: [browserEvidence.id], executorId: "fixture" };
  const browserSuites = [suite("livedemo/browser/suite", "browser-journeys", [browserCase], [browserEvidence])];
  const certificationSuites = Array.from({ length: options.certificationCount ?? 3 }, (_, index) =>
    suite(`verification/cert-${index}`, "certification-aggregate", [], [evidence(`cert/${index}:e1`, `certification ${index}`)]));
  const reports: Record<string, any> = {
    semantic: report("run-semantic", [semanticCaseId, "unit/opaque-suite"], semanticSuites),
    browser: report("run-browser", [browserCase.id], browserSuites),
    certification: report("run-certification", certificationSuites.map((entry) => entry.id), certificationSuites),
  };
  const raw: Record<string, Buffer> = {};
  for (const [name, value] of Object.entries(reports)) {
    raw[name] = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    await writeFile(join(capture, `${name}.json`), raw[name]);
  }
  const metadata = {
    capturedAt: "2026-08-24T00:00:00.000Z",
    deployment: { hsonDeployCommit: "a".repeat(40), hsonDemo2Gitlink: "b".repeat(40), hsonLiveGitlink: "c".repeat(40), intrastructureGitlink: "d".repeat(40) },
    runtime: { nodeVersion: "v22.20.0", platform: "darwin", architecture: "arm64" },
    selectedStages: ["semantic", "browser", "certification"],
    selection: {
      semantic: { idCount: 2, ids: reports.semantic.plan.selectionIds },
      browser: { idCount: 1, ids: reports.browser.plan.selectionIds },
      certification: { idCount: certificationSuites.length, ids: reports.certification.plan.selectionIds },
    },
    runs: Object.fromEntries(Object.entries(reports).map(([name, value]) => [name, {
      runId: value.run.id, attemptId: `${value.run.id}:attempt:1`, reportHostId: `host:${name}`, reportRev: 1, clientAppliedReportRev: 1,
      reportFile: `${name}.json`, selectionCount: value.plan.selectionIds.length,
      ...(name === "browser" ? { journeyCount: 1 } : {}), terminalStatus: "passed", rawBytes: raw[name].byteLength,
    }])),
  };
  const cleanup = {
    clientSockets: { total: 0, hostedTests: { total: 0 }, towl: 0, circuitVerification: 0 },
    browser: { activeProcesses: 0, activeJourneys: 0, retainedArtifactRoots: 0, forcedTerminations: 0 },
  };
  await writeFile(join(capture, "capture-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  await writeFile(join(capture, "capture-cleanup.json"), `${JSON.stringify(cleanup, null, 2)}\n`);
  return { candidate: join(root, "candidate"), capture, reports, metadata };
}
