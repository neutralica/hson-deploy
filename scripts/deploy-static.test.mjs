import assert from "node:assert/strict";
import test from "node:test";
import { execute_static_deploy, PAGES_BRANCH, PAGES_PROJECT, STATIC_DIRECTORY } from "./deploy-static.mjs";

const PROJECTS = [{ "Project Name": PAGES_PROJECT }, { "Project Name": "unrelated" }];
const verification = Object.freeze({ artifact: "/fixture/hson-deploy/static-production", evidenceRoot: "/test-evidence/11111111-1111-4111-8111-111111111111", visitorExecutionAbsent: true });

function runner(calls, projects = PROJECTS) {
  return (command, arguments_, options) => {
    calls.push({ command, arguments_, options });
    if (arguments_.join(" ") === "pages project list --json") return JSON.stringify(projects);
    return "uploaded exact fixture bytes\n";
  };
}

test("deploy:static validates then uploads the exact existing artifact to the guarded target", async () => {
  const calls = [];
  const verifications = [];
  const result = await execute_static_deploy({
    deploymentRoot: "/fixture/hson-deploy",
    environment: { CLOUDFLARE_API_TOKEN: "fixture" },
    run: runner(calls),
    verifyArtifact: async (options) => { verifications.push(options); return verification; },
  });
  assert.deepEqual(verifications, [{ artifact: "/fixture/hson-deploy/static-production", requireSecurePublic: true }]);
  assert.deepEqual(calls.map(({ command, arguments_ }) => `${command} ${arguments_.join(" ")}`), [
    "wrangler pages project list --json",
    `wrangler pages deploy ${STATIC_DIRECTORY} --project-name=${PAGES_PROJECT} --branch=${PAGES_BRANCH}`,
  ]);
  assert.equal(result.directory, "/fixture/hson-deploy/static-production");
  assert.doesNotMatch(calls.map(({ command, arguments_ }) => `${command} ${arguments_.join(" ")}`).join("\n"), /npm|build|test:|playwright|git|submodule/);
});

test("malformed or insecure artifacts stop before provider access", async () => {
  const calls = [];
  await assert.rejects(execute_static_deploy({ deploymentRoot: "/fixture/hson-deploy", environment: { CLOUDFLARE_API_TOKEN: "fixture" }, run: runner(calls), verifyArtifact: async () => { throw new Error("Static deployment requires a public wss:// LiveHost origin."); } }), /public wss:\/\//);
  assert.deepEqual(calls, []);

  await assert.rejects(execute_static_deploy({ deploymentRoot: "/fixture/hson-deploy", environment: { CLOUDFLARE_API_TOKEN: "fixture" }, run: runner(calls), verifyArtifact: async () => { throw new Error("Static production configuration is malformed."); } }), /configuration is malformed/);
  assert.deepEqual(calls, []);
});

test("wrong Pages target stops before upload", async () => {
  const calls = [];
  await assert.rejects(execute_static_deploy({ deploymentRoot: "/fixture/hson-deploy", environment: { CLOUDFLARE_API_TOKEN: "fixture" }, run: runner(calls, [{ "Project Name": "wrong-project" }]), verifyArtifact: async () => verification }), /expected hson-deploy/);
  assert.equal(calls.filter(({ arguments_ }) => arguments_.includes("deploy")).length, 0);
});

test("unnamed project rows cannot satisfy the target guard", async () => {
  const calls = [];
  await assert.rejects(execute_static_deploy({ deploymentRoot: "/fixture/hson-deploy", environment: { CLOUDFLARE_API_TOKEN: "fixture" }, run: runner(calls, [{ domains: "hson-deploy.pages.dev" }]), verifyArtifact: async () => verification }), /available projects: \(none\)/);
  assert.equal(calls.filter(({ arguments_ }) => arguments_.includes("deploy")).length, 0);
});
