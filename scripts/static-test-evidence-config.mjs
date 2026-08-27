import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

const EXPLORER_CATEGORIES = ["transform", "livetree", "livemap", "locus", "livehost", "reflect", "unit", "browser", "certification"];

function parse_json(path, label) {
  let source;
  try { source = readFileSync(path, "utf8"); }
  catch (cause) { throw new Error(`${label} could not be read at ${path}.`, { cause }); }
  try { return JSON.parse(source); }
  catch (cause) { throw new Error(`${label} is not valid JSON at ${path}.`, { cause }); }
}

function encoded(id) { return Buffer.from(id, "utf8").toString("base64url"); }

function checked_reference(evidenceRoot, reference, kind, id) {
  const expected = `${kind}/${encoded(id)}.json`;
  if (reference?.available !== true || reference.path !== expected) throw new Error(`Accepted Phase 3 ${kind} reference is invalid for ${id}.`);
  const artifactPath = resolve(evidenceRoot, reference.path);
  if (!artifactPath.startsWith(`${evidenceRoot}/`) || !existsSync(artifactPath)) throw new Error(`Accepted Phase 3 ${kind} evidence is missing at ${artifactPath}.`);
  const bytes = readFileSync(artifactPath);
  if (bytes.byteLength !== reference.rawBytes || createHash("sha256").update(bytes).digest("hex") !== reference.sha256) {
    throw new Error(`Accepted Phase 3 ${kind} evidence metadata does not match ${reference.path}.`);
  }
  return parse_json(artifactPath, `Accepted Phase 3 ${kind} evidence`);
}

export function validate_static_test_evidence_root(value) {
  if (value === undefined) throw new Error("VITE_TEST_EVIDENCE_ROOT is required for static production preparation.");
  const root = value.trim();
  if (root === "") throw new Error("VITE_TEST_EVIDENCE_ROOT must not be empty.");
  if (!root.startsWith("/")) throw new Error("VITE_TEST_EVIDENCE_ROOT must be root-relative.");
  if (root.includes("?") || root.includes("#")) throw new Error("VITE_TEST_EVIDENCE_ROOT must not contain a query string or fragment.");
  if (root.includes("\\") || root.split("/").some((part) => part === "." || part === "..")) throw new Error("VITE_TEST_EVIDENCE_ROOT must not contain traversal.");
  if (root.toLowerCase().split("/").includes("latest")) throw new Error("VITE_TEST_EVIDENCE_ROOT must not use a mutable latest root.");
  const match = /^\/test-evidence\/([0-9a-f]{40})$/.exec(root);
  if (match === null) throw new Error("VITE_TEST_EVIDENCE_ROOT must end in one exact lowercase 40-hex hson-deploy commit.");
  return Object.freeze({ root, deploymentCommit: match[1] });
}

export function validate_accepted_static_test_evidence(environment = process.env) {
  const configured = validate_static_test_evidence_root(environment.VITE_TEST_EVIDENCE_ROOT);
  const acceptanceValue = environment.TEST_EVIDENCE_ACCEPTANCE_FILE?.trim();
  if (acceptanceValue === undefined || acceptanceValue === "") {
    throw new Error("TEST_EVIDENCE_ACCEPTANCE_FILE is required to bind static production to accepted Phase 3 evidence.");
  }
  const acceptancePath = resolve(acceptanceValue);
  const acceptance = parse_json(acceptancePath, "Phase 3 evidence acceptance");
  if (acceptance?.accepted !== true || typeof acceptance.evidenceRoot !== "string") {
    throw new Error("Phase 3 evidence acceptance must be accepted and contain evidenceRoot.");
  }
  if (`/${acceptance.evidenceRoot}` !== configured.root) {
    throw new Error(`VITE_TEST_EVIDENCE_ROOT ${configured.root} does not match accepted evidence root /${acceptance.evidenceRoot}.`);
  }
  const evidenceRoot = resolve(dirname(acceptancePath), "site", acceptance.evidenceRoot);
  const indexPath = resolve(evidenceRoot, "index.json");
  if (!existsSync(indexPath)) throw new Error(`Accepted Phase 3 evidence index is missing at ${indexPath}.`);
  const index = parse_json(indexPath, "Accepted Phase 3 evidence index");
  if (index?.deployment?.hsonDeployCommit !== configured.deploymentCommit) {
    throw new Error("Accepted Phase 3 index deployment commit does not match VITE_TEST_EVIDENCE_ROOT.");
  }
  const categoryIds = new Set();
  const suiteIds = new Set();
  const caseIds = new Set();
  let artifacts = 0;
  for (const category of index.categories ?? []) {
    if (categoryIds.has(category.id)) throw new Error(`Accepted Phase 3 category is duplicated: ${category.id}.`);
    categoryIds.add(category.id);
    const categoryArtifact = checked_reference(evidenceRoot, category.listing, "categories", category.id);
    artifacts += 1;
    if (categoryArtifact.categoryId !== category.id) throw new Error(`Accepted Phase 3 category identity does not match ${category.id}.`);
    for (const suite of categoryArtifact.suites ?? []) {
      if (suite.categoryId !== category.id || suiteIds.has(suite.id)) throw new Error(`Accepted Phase 3 suite category or identity does not match ${suite.id}.`);
      suiteIds.add(suite.id);
      const suiteArtifact = checked_reference(evidenceRoot, suite.listing, "suites", suite.id);
      artifacts += 1;
      if (suiteArtifact.categoryId !== category.id || suiteArtifact.suiteId !== suite.id) throw new Error(`Accepted Phase 3 suite envelope identity does not match ${suite.id}.`);
      for (const item of suiteArtifact.cases ?? []) {
        if (caseIds.has(item.id) || item.id !== `${suite.id}::${item.caseId}`) throw new Error(`Accepted Phase 3 case identity does not match ${item.id}.`);
        caseIds.add(item.id);
        if (item.evidence?.available !== true) continue;
        const caseArtifact = checked_reference(evidenceRoot, item.evidence, "cases", item.id);
        artifacts += 1;
        if (caseArtifact.suiteId !== suite.id || caseArtifact.caseId !== item.id) throw new Error(`Accepted Phase 3 case envelope identity does not match ${item.id}.`);
      }
    }
  }
  if (JSON.stringify([...categoryIds]) !== JSON.stringify(EXPLORER_CATEGORIES)) throw new Error("Accepted Phase 3 index does not contain the canonical explorer category set.");
  return Object.freeze({ ...configured, acceptancePath, evidenceRoot, indexPath, rows: artifacts, artifacts });
}
