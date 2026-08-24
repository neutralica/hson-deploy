import assert from "node:assert/strict";
import test from "node:test";
import { execute_static_deploy, PAGES_BRANCH, PAGES_PROJECT, STATIC_DIRECTORY } from "./deploy-static.mjs";

function authority() {
  return {
    artifact: "/fixture/hson-deploy/static-production",
    environment: {
      VITE_TEST_EVIDENCE_ROOT: `/test-evidence/${"a".repeat(40)}`,
      TEST_EVIDENCE_ACCEPTANCE_FILE: "/fixture/accepted.json",
    },
  };
}

function successful_runner(calls, projects = [{ name: PAGES_PROJECT }]) {
  return (command, arguments_, options) => {
    calls.push({ command, arguments_, options });
    if (command === "wrangler" && arguments_.join(" ") === "pages project list --json") return JSON.stringify(projects);
    if (command === "git") return `${"b".repeat(40)}\n`;
    if (command === "wrangler") return "✨ Deployment complete! https://fixture.pages.dev\n";
    return "";
  };
}

test("deploy:static verifies first and publishes the exact directory to the guarded Pages project", () => {
  const calls = [];
  const result = execute_static_deploy({ deploymentRoot: "/fixture/hson-deploy", run: successful_runner(calls), resolveVerification: authority, environment: {} });
  assert.deepEqual(calls.map(({ command, arguments_ }) => `${command} ${arguments_.join(" ")}`), [
    "npm run verify:static-production-artifact",
    "wrangler pages project list --json",
    "git rev-parse HEAD",
    `wrangler pages deploy ${STATIC_DIRECTORY} --project-name=${PAGES_PROJECT} --branch=${PAGES_BRANCH} --commit-hash=${"b".repeat(40)} --commit-dirty=false`,
  ]);
  assert.equal(result.project, "hson-deploy");
  assert.equal(result.directory, "/fixture/hson-deploy/static-production");
  const invocations = calls.map(({ command, arguments_ }) => `${command} ${arguments_.join(" ")}`).join("\n");
  assert.doesNotMatch(invocations, /deploy:worker|certify|npm run build/);
});

test("artifact verification failure prevents every provider invocation", () => {
  const calls = [];
  const run = (command, arguments_, options) => {
    calls.push({ command, arguments_, options });
    throw new Error("artifact invalid");
  };
  assert.throws(() => execute_static_deploy({ deploymentRoot: "/fixture/hson-deploy", run, resolveVerification: authority, environment: {} }), /artifact invalid/);
  assert.deepEqual(calls.map(({ command, arguments_ }) => `${command} ${arguments_.join(" ")}`), ["npm run verify:static-production-artifact"]);
});

test("provider target guard refuses deployment when the expected Pages project is absent", () => {
  const calls = [];
  assert.throws(() => execute_static_deploy({
    deploymentRoot: "/fixture/hson-deploy",
    run: successful_runner(calls, [{ name: "another-project" }]),
    resolveVerification: authority,
    environment: {},
  }), /expected hson-deploy/);
  assert.equal(calls.filter(({ arguments_ }) => arguments_.includes("deploy")).length, 0);
});
