import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  PACK_STAGES,
  canonical_package_locations,
  execute_certification,
  execute_pack,
  resolve_deployment_root,
  write_certification_receipt,
} from "../../hson-demo2/scripts/certified-package.mjs";

const deploymentRoot = resolve(import.meta.dirname, "..");
const applicationRoot = resolve(deploymentRoot, "..", "hson-demo2");
const libraryRoot = resolve(deploymentRoot, "..", "hson-live");

function successful_runner(calls) {
  return (command, arguments_, options) => {
    calls.push({ command, arguments_, cwd: options.cwd, env: options.env });
    const invocation = arguments_.join(" ");
    if (invocation === "run capture:deployment-tests:normal") return `${join(deploymentRoot, ".deployment-work", "capture-fixture")}\n`;
    if (invocation.startsWith("run materialize:test-evidence --")) return `npm banner\n${JSON.stringify({
      candidate: join(deploymentRoot, ".deployment-work", "materialize-fixture"),
      publicRoot: "/test-evidence/0123456789012345678901234567890123456789",
      artifactSetSha256: "a".repeat(64),
    })}`;
    return "";
  };
}

test("hson-demo2 owns one pack implementation and hson-live is only a consumer wrapper", () => {
  const app = JSON.parse(readFileSync(join(applicationRoot, "package.json"), "utf8"));
  const library = JSON.parse(readFileSync(join(libraryRoot, "package.json"), "utf8"));
  const deployedApp = JSON.parse(readFileSync(join(deploymentRoot, "hson-demo2", "package.json"), "utf8"));
  assert.equal(app.scripts.pack, "node scripts/certified-package.mjs pack");
  assert.equal(app.scripts.certify, "node scripts/certified-package.mjs certify");
  assert.equal(library.scripts["pack:consumer"], "node ../hson-demo2/scripts/certified-package.mjs pack");
  assert.equal(library.scripts.build, "npm run clean && tsc");
  assert.doesNotMatch(library.scripts.build, /test|pack|certif|hson-demo2/);
  assert.equal(deployedApp.scripts.pack, app.scripts.pack);
  assert.equal(
    readFileSync(join(deploymentRoot, "hson-demo2", "scripts", "certified-package.mjs"), "utf8").trimEnd(),
    readFileSync(join(applicationRoot, "scripts", "certified-package.mjs"), "utf8").trimEnd(),
    "the deployment checkout uses the same application-owned implementation",
  );
});

test("pack enforces clean pinned source before capture and uses the existing artifact path once", () => {
  const calls = [];
  const result = execute_pack({ deploymentRoot, run: successful_runner(calls), environment: {} });
  assert.deepEqual(PACK_STAGES, ["verify-source", "build-runtime", "verify-package-surfaces", "capture-normal-evidence", "materialize", "assemble-and-verify-explorer"]);
  assert.deepEqual(calls.map((call) => call.arguments_.join(" ")), [
    "run verify",
    "-w hson-live run build",
    "run verify:package-surface",
    "run capture:deployment-tests:normal",
    `run materialize:test-evidence -- ${join(deploymentRoot, ".deployment-work", "capture-fixture")}`,
    "run prepare:static-production",
  ]);
  assert.equal(result.explorerArtifact, join(deploymentRoot, "static-production"));
  assert.equal(calls.filter((call) => call.arguments_.includes("prepare:static-production")).length, 1);
  assert.equal(calls.at(-1).env.VITE_TEST_EVIDENCE_ROOT, "/test-evidence/0123456789012345678901234567890123456789");
  assert.equal(calls.at(-1).env.TEST_EVIDENCE_ACCEPTANCE_FILE, join(result.evidencePackage, "accepted.json"));
});

test("a source verification failure stops before any execution or artifact generation", () => {
  const calls = [];
  assert.throws(() => execute_pack({
    deploymentRoot,
    environment: {},
    run(command, arguments_, options) {
      calls.push({ command, arguments_, options });
      throw new Error("workspace is not clean");
    },
  }), /workspace is not clean/);
  assert.deepEqual(calls.map((call) => call.arguments_.join(" ")), ["run verify"]);
});

test("certify runs the full integrated authority and then the exact pack flow", () => {
  const calls = [];
  const receipts = [];
  const result = execute_certification({ deploymentRoot, run: successful_runner(calls), environment: {}, writeReceipt(packed) { receipts.push(packed); return { path: "receipt.json" }; } });
  assert.equal(calls[0].arguments_.join(" "), "run verify");
  assert.equal(calls[1].arguments_.join(" "), "-w hson-demo2 run test:inclusive-library-node");
  assert.equal(calls[2].arguments_.join(" "), "run verify");
  assert.equal(calls.filter((call) => call.arguments_.includes("capture:deployment-tests:normal")).length, 1);
  assert.equal(receipts.length, 1);
  assert.equal(result.certified, true);
  assert.deepEqual(result.certificationReceipt, { path: "receipt.json" });
});

test("certification receipt binds the authority result to the packed evidence identity", () => {
  const explorerArtifact = join(mkdtempSync(join(tmpdir(), "hson-certified-explorer-")), "artifact");
  mkdirSync(explorerArtifact);
  const receipt = write_certification_receipt({
    explorerArtifact,
    evidenceRoot: "/test-evidence/0123456789012345678901234567890123456789",
    artifactSetSha256: "a".repeat(64),
  }, "2026-08-24T12:00:00.000Z");
  const stored = JSON.parse(readFileSync(receipt.path, "utf8"));
  assert.equal(stored.certified, true);
  assert.equal(stored.deploymentCommit, "0123456789012345678901234567890123456789");
  assert.equal(stored.evidenceArtifactSetSha256, "a".repeat(64));
  assert.match(stored.authority, /test:inclusive-library-node/);
});

test("application, deployment, and library entrypoints converge on one canonical location", () => {
  assert.equal(resolve_deployment_root(applicationRoot, {}), deploymentRoot);
  const locations = canonical_package_locations(deploymentRoot);
  assert.deepEqual(locations, {
    workRoot: join(deploymentRoot, ".deployment-work"),
    explorerArtifact: join(deploymentRoot, "static-production"),
  });
});
