import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

function parse_json(path, label) {
  let source;
  try { source = readFileSync(path, "utf8"); }
  catch (cause) { throw new Error(`${label} could not be read at ${path}.`, { cause }); }
  try { return JSON.parse(source); }
  catch (cause) { throw new Error(`${label} is not valid JSON at ${path}.`, { cause }); }
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
  let rows = 0;
  for (const suite of index.suites ?? []) {
    for (const reference of [suite.evidence, ...(suite.cases ?? []).map((item) => item.evidence)]) {
      if (reference?.available !== true) continue;
      if (typeof reference.path !== "string" || !/^(?:cases|suites)\/[A-Za-z0-9_-]+\.json$/.test(reference.path)) {
        throw new Error("Accepted Phase 3 index contains an invalid public row evidence path.");
      }
      const artifactPath = resolve(evidenceRoot, reference.path);
      if (!existsSync(artifactPath)) throw new Error(`Accepted Phase 3 row evidence is missing at ${artifactPath}.`);
      const artifact = readFileSync(artifactPath);
      if (artifact.byteLength !== reference.rawBytes || createHash("sha256").update(artifact).digest("hex") !== reference.sha256) {
        throw new Error(`Accepted Phase 3 row evidence metadata does not match ${reference.path}.`);
      }
      rows += 1;
    }
  }
  return Object.freeze({ ...configured, acceptancePath, evidenceRoot, indexPath, rows });
}
