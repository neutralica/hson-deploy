import assert from "node:assert/strict";
import test from "node:test";
import { execute_static_deploy, PAGES_BRANCH, PAGES_PROJECT, STATIC_DIRECTORY } from "./deploy-static.mjs";

const OBSERVED_WRANGLER_PROJECTS = [
  {
    "Project Name": "hson-deploy",
    "Project Domains": "hson-deploy.pages.dev, hson.terminalgothic.com, terminal-gothic.com, terminalgothic.com",
    "Git Provider": "Yes",
    "Last Modified": "1 hour ago",
  },
  {
    "Project Name": "spp-llc",
    "Project Domains": "spp-llc.pages.dev, spp.terminalgothic.com",
    "Git Provider": "Yes",
    "Last Modified": "2 months ago",
  },
];

function authority() {
  return {
    artifact: "/fixture/hson-deploy/static-production",
    evidenceRoot: `/test-evidence/${"a".repeat(40)}`,
    environment: {
      VITE_TEST_EVIDENCE_ROOT: `/test-evidence/${"a".repeat(40)}`,
      TEST_EVIDENCE_ACCEPTANCE_FILE: "/fixture/accepted.json",
      VITE_LIVEHOST_WS_URL: "wss://runtime.example",
    },
  };
}

function successful_runner(calls, projects = OBSERVED_WRANGLER_PROJECTS) {
  return (command, arguments_, options) => {
    calls.push({ command, arguments_, options });
    if (command === "wrangler" && arguments_.join(" ") === "pages project list --json") return JSON.stringify(projects);
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
    `wrangler pages deploy ${STATIC_DIRECTORY} --project-name=${PAGES_PROJECT} --branch=${PAGES_BRANCH} --commit-hash=${"a".repeat(40)} --commit-dirty=false`,
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
    run: successful_runner(calls, [{ "Project Name": "another-project" }]),
    resolveVerification: authority,
    environment: {},
  }), /expected hson-deploy; available projects: another-project/);
  assert.equal(calls.filter(({ arguments_ }) => arguments_.includes("deploy")).length, 0);
});

test("provider target guard refuses Wrangler display rows without a project name", () => {
  const calls = [];
  assert.throws(() => execute_static_deploy({
    deploymentRoot: "/fixture/hson-deploy",
    run: successful_runner(calls, [{ "Project Domains": "another-project.pages.dev" }]),
    resolveVerification: authority,
    environment: {},
  }), /expected hson-deploy; available projects: \(none\)/);
  assert.equal(calls.filter(({ arguments_ }) => arguments_.includes("deploy")).length, 0);
});
