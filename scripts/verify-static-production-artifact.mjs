import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { validate_accepted_static_test_evidence } from "./static-test-evidence-config.mjs";

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function public_json(publicRoot, reference, kind) {
  if (typeof reference?.path !== "string" || !new RegExp(`^${kind}/[A-Za-z0-9_-]+\\.json$`).test(reference.path)) throw new Error(`Public frozen index has an invalid ${kind} path.`);
  const path = resolve(publicRoot, reference.path);
  if (!path.startsWith(`${publicRoot}/`) || !existsSync(path)) throw new Error(`Public frozen artifact is missing: ${reference.path}.`);
  const bytes = readFileSync(path);
  if (bytes.byteLength !== reference.rawBytes || sha256(bytes) !== reference.sha256 || statSync(path).size !== reference.rawBytes) throw new Error(`Public frozen artifact metadata mismatch: ${reference.path}.`);
  return { path: reference.path, bytes, value: JSON.parse(bytes.toString("utf8")) };
}

function public_references(index, publicRoot) {
  const records = [];
  const suites = new Set();
  const cases = new Set();
  for (const category of index.categories ?? []) {
    const categoryRecord = public_json(publicRoot, category.listing, "categories");
    if (categoryRecord.value.categoryId !== category.id) throw new Error(`Public frozen category identity mismatch: ${category.id}.`);
    records.push(categoryRecord);
    for (const suite of categoryRecord.value.suites ?? []) {
      if (suite.categoryId !== category.id || suites.has(suite.id)) throw new Error(`Public frozen suite category or identity mismatch: ${suite.id}.`);
      suites.add(suite.id);
      const suiteRecord = public_json(publicRoot, suite.listing, "suites");
      if (suiteRecord.value.categoryId !== category.id || suiteRecord.value.suiteId !== suite.id) throw new Error(`Public frozen suite envelope identity mismatch: ${suite.id}.`);
      records.push(suiteRecord);
      for (const item of suiteRecord.value.cases ?? []) {
        if (cases.has(item.id) || item.id !== `${suite.id}::${item.caseId}`) throw new Error(`Public frozen case identity mismatch: ${item.id}.`);
        cases.add(item.id);
        if (item.evidence?.available !== true) continue;
        const caseRecord = public_json(publicRoot, item.evidence, "cases");
        if (caseRecord.value.suiteId !== suite.id || caseRecord.value.caseId !== item.id) throw new Error(`Public frozen case envelope identity mismatch: ${item.id}.`);
        records.push(caseRecord);
      }
    }
  }
  return records;
}

export function verify_static_production_artifact(options = {}) {
  const root = resolve(import.meta.dirname, "..");
  const artifact = resolve(options.artifact ?? resolve(root, "static-production"));
  const environment = options.environment ?? process.env;
  const evidence = validate_accepted_static_test_evidence(environment);
  const publicRoot = resolve(artifact, evidence.root.slice(1));
  if (!existsSync(resolve(artifact, "index.html"))) throw new Error("Static production artifact is missing static-production/index.html.");
  if (!existsSync(resolve(publicRoot, "index.json"))) throw new Error("Static production artifact is missing its public frozen index.");
  if (existsSync(resolve(publicRoot, "reports")) || existsSync(resolve(publicRoot, "provenance.json"))) throw new Error("Static production artifact exposes archive-only frozen evidence.");

  const sources = files(artifact).filter((path) => /\.(?:html|js|css)$/.test(path)).map((path) => readFileSync(path, "utf8"));
  if (!sources.some((source) => source.includes(evidence.root))) throw new Error("Static production artifact does not contain the exact accepted VITE_TEST_EVIDENCE_ROOT.");
  const embeddedRoots = [...sources.join("\n").matchAll(/\/test-evidence\/([0-9a-f]{40})/g)].map((match) => match[1]);
  if (embeddedRoots.some((commit) => commit !== evidence.deploymentCommit)) throw new Error("Static production artifact contains a stale test-evidence root.");
  if (sources.some((source) => /\/test-evidence\/(?:latest|current)(?:[/?#"']|$)/i.test(source))) throw new Error("Static production artifact contains a mutable test-evidence root.");

  const frozenPanelSources = sources.filter((source) => source.includes("data-frozen-panel-state") || source.includes("frozen-test-panel"));
  if (frozenPanelSources.length === 0) throw new Error("Static production artifact is missing the frozen test panel chunk.");
  for (const forbidden of ["tests.discover", "tests.runSelected", "tests.inspect", "tests.cancel", "make_remote_hosted_test_runtime", "HostedTestPanelRuntime", "HostedTestPanelAdapter", "VITE_HOSTED_TEST_WS_URL"]) {
    if (frozenPanelSources.some((source) => source.includes(forbidden))) throw new Error(`Frozen test panel production chunk retains live hosted-test acquisition marker: ${forbidden}.`);
  }

  const index = JSON.parse(readFileSync(resolve(publicRoot, "index.json"), "utf8"));
  if (JSON.stringify(index).includes("reports/")) throw new Error("Public frozen index references an omitted canonical report.");
  const references = public_references(index, publicRoot);
  const rowBytes = references.reduce((total, record) => total + record.bytes.byteLength, 0);
  const referenced = new Set(["index.json", ...references.map((record) => record.path)]);
  const actualEvidenceFiles = files(publicRoot).map((path) => path.slice(publicRoot.length + 1));
  if (actualEvidenceFiles.some((path) => !referenced.has(path))) throw new Error("Static production artifact contains an unreferenced public frozen artifact.");
  return Object.freeze({ evidenceRoot: evidence.root, frozenPanelSources: frozenPanelSources.length, rowArtifacts: references.length, rowBytes });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verify_static_production_artifact();
  console.log(`Static production artifact: ${result.rowArtifacts} frozen row artifacts match raw bytes; exact root ${result.evidenceRoot} is embedded and its panel chunk excludes hosted-test acquisition.`);
}
