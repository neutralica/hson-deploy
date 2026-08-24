import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { verify_static_production_artifact } from "./verify-static-production-artifact.mjs";

const EVIDENCE_ROOT_PATTERN = /^test-evidence\/([0-9a-f]{40})$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function read_json(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return undefined; }
}

function accepted_files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return accepted_files(path);
    return entry.isFile() && entry.name === "accepted.json" ? [path] : [];
  });
}

function artifact_evidence_roots(artifact) {
  const directory = join(artifact, "test-evidence");
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9a-f]{40}$/.test(entry.name))
    .map((entry) => `/test-evidence/${entry.name}`)
    .sort();
}

export function accepted_evidence_candidates(deploymentRoot, evidenceRoot) {
  return accepted_files(join(deploymentRoot, ".deployment-work"))
    .map((path) => ({ path, value: read_json(path) }))
    .filter(({ value }) => value?.accepted === true && `/${value.evidenceRoot}` === evidenceRoot)
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function resolve_static_artifact_verification(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const artifact = resolve(options.artifact ?? join(deploymentRoot, "static-production"));
  const roots = artifact_evidence_roots(artifact);
  if (roots.length !== 1) {
    throw new Error(`Static production artifact must contain exactly one immutable test-evidence root; found ${roots.length}.`);
  }
  const evidenceRoot = roots[0];
  const candidates = accepted_evidence_candidates(deploymentRoot, evidenceRoot);
  if (candidates.length === 0) {
    throw new Error(`No accepted Phase 3 materialization matches ${evidenceRoot}.`);
  }
  const preferredHash = options.evidenceArtifactSetSha256;
  const eligible = preferredHash === undefined
    ? candidates
    : candidates.filter(({ value }) => value.artifactSet === preferredHash);
  if (eligible.length === 0) {
    throw new Error(`No accepted Phase 3 materialization matches ${evidenceRoot} and the certified evidence hash.`);
  }
  let lastError;
  for (const candidate of eligible) {
    const environment = {
      VITE_TEST_EVIDENCE_ROOT: evidenceRoot,
      TEST_EVIDENCE_ACCEPTANCE_FILE: candidate.path,
    };
    try {
      const verification = verify_static_production_artifact({ artifact, environment });
      return Object.freeze({ deploymentRoot, artifact, evidenceRoot, acceptanceFile: candidate.path, artifactSetSha256: candidate.value.artifactSet, environment, verification });
    } catch (cause) { lastError = cause; }
  }
  throw new Error(`Static production artifact does not match any accepted materialization for ${evidenceRoot}.`, { cause: lastError });
}

function git_head(deploymentRoot) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: deploymentRoot, encoding: "utf8" }).trim();
}

export function inspect_reusable_certified_artifact(options = {}) {
  const deploymentRoot = resolve(options.deploymentRoot ?? resolve(import.meta.dirname, ".."));
  const artifact = resolve(options.artifact ?? join(deploymentRoot, "static-production"));
  const receiptPath = join(artifact, "certification-receipt.json");
  const receipt = read_json(receiptPath);
  const currentCommit = (options.currentCommit ?? git_head)(deploymentRoot);
  if (receipt?.schemaVersion !== 1 || receipt.kind !== "hson-tests-explorer-certification" || receipt.certified !== true) {
    return Object.freeze({ reusable: false, reason: "certification receipt missing or invalid" });
  }
  if (receipt.deploymentCommit !== currentCommit || receipt.evidenceRoot !== `/test-evidence/${currentCommit}`) {
    return Object.freeze({ reusable: false, reason: "certified source revision does not match current deployment revision" });
  }
  if (!HASH_PATTERN.test(receipt.evidenceArtifactSetSha256 ?? "")) {
    return Object.freeze({ reusable: false, reason: "certified evidence identity is missing or invalid" });
  }
  try {
    const authority = resolve_static_artifact_verification({
      deploymentRoot,
      artifact,
      evidenceArtifactSetSha256: receipt.evidenceArtifactSetSha256,
    });
    if (authority.artifactSetSha256 !== receipt.evidenceArtifactSetSha256 || !EVIDENCE_ROOT_PATTERN.test(authority.evidenceRoot.slice(1))) {
      return Object.freeze({ reusable: false, reason: "certification and evidence identity do not match" });
    }
    return Object.freeze({ reusable: true, receipt, receiptPath, authority });
  } catch (cause) {
    return Object.freeze({ reusable: false, reason: cause instanceof Error ? cause.message : String(cause) });
  }
}
