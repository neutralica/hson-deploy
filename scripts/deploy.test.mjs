import assert from "node:assert/strict";
import test from "node:test";
import { execute_deploy } from "./deploy.mjs";

test("ordinary deploy routes only to deployment of the existing static artifact", () => {
  const calls = [];
  const environment = { CLOUDFLARE_API_TOKEN: "fixture" };
  const result = execute_deploy({
    deploymentRoot: "/fixture/hson-deploy",
    environment,
    run(command, arguments_, options) { calls.push({ command, arguments_, options }); return ""; },
  });
  assert.deepEqual(result, { route: "static" });
  assert.deepEqual(calls.map(({ command, arguments_ }) => `${command} ${arguments_.join(" ")}`), ["npm run deploy:static"]);
  assert.equal(calls[0].options.env, environment);
  assert.doesNotMatch(calls[0].arguments_.join(" "), /latest|build|test:|certif|capture|subs:update|submodule/);
});
