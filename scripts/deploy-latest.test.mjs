import assert from "node:assert/strict";
import test from "node:test";
import { commit_updated_source_gitlinks, require_gitlink_only_deployment_state, run_latest_deploy_command } from "./deploy-latest.mjs";

const synchronization = Object.freeze([
  Object.freeze({ name: "hson-live", previous: "a", intended: "b", changed: true }),
  Object.freeze({ name: "hson-demo2", previous: "c", intended: "c", changed: false }),
]);

test("deploy:latest holds one outer lock across sync, gitlink commit, and normal deploy", async () => {
  const order = [];
  const result = await run_latest_deploy_command({
    deploymentRoot: "/fixture/hson-deploy",
    withLock: async (options, operation) => {
      assert.equal(options.command, "deploy:latest");
      order.push("lock");
      try { return await operation(); }
      finally { order.push("unlock"); }
    },
    requireState: () => order.push("check downstream state"),
    synchronize: () => { order.push("sync"); return synchronization; },
    printResults: () => order.push("report revisions"),
    commitGitlinks: () => { order.push("commit gitlinks"); return "commit"; },
    deploy: () => { order.push("deploy pinned source"); return "deployed"; },
  });
  assert.deepEqual(order, ["lock", "check downstream state", "sync", "report revisions", "commit gitlinks", "deploy pinned source", "unlock"]);
  assert.deepEqual(result, { synchronization, commit: "commit", deployment: "deployed" });
  assert.equal(order.some((step) => /push/.test(step)), false);
});

test("deploy:latest creates no bookkeeping commit for no-op synchronization", async () => {
  const result = await run_latest_deploy_command({
    deploymentRoot: "/fixture/hson-deploy",
    withLock: async (_options, operation) => operation(),
    requireState: () => undefined,
    synchronize: () => synchronization.map((result) => ({ ...result, previous: result.intended, changed: false })),
    printResults: () => undefined,
    commitGitlinks: () => undefined,
    deploy: () => "deployed",
  });
  assert.equal(result.commit, undefined);
});

test("gitlink bookkeeping stages and commits only managed gitlinks", () => {
  const calls = [];
  const outputs = [" M hson-live\n M hson-demo2", "", "hson-live\nhson-demo2", "", "fixture-commit"];
  const commit = commit_updated_source_gitlinks({
    deploymentRoot: "/fixture/hson-deploy",
    run(command, arguments_, options) {
      calls.push({ command, arguments_, cwd: options.cwd });
      return outputs.shift();
    },
  });
  assert.equal(commit, "fixture-commit");
  assert.deepEqual(calls.map(({ arguments_ }) => arguments_), [
    ["status", "--porcelain", "--untracked-files=no"],
    ["add", "--", "hson-live", "hson-demo2"],
    ["diff", "--cached", "--name-only"],
    ["commit", "-m", "Update source gitlinks"],
    ["rev-parse", "HEAD"],
  ]);
  assert.equal(calls.every(({ cwd }) => cwd === "/fixture/hson-deploy"), true);
  assert.equal(calls.some(({ arguments_ }) => arguments_.includes("push")), false);
});

test("gitlink bookkeeping makes no commit when the managed index is unchanged", () => {
  const calls = [];
  const outputs = ["", "", ""];
  const commit = commit_updated_source_gitlinks({
    deploymentRoot: "/fixture/hson-deploy",
    run(_command, arguments_) { calls.push(arguments_); return outputs.shift(); },
  });
  assert.equal(commit, undefined);
  assert.equal(calls.some((arguments_) => arguments_[0] === "commit"), false);
});

test("deploy:latest rejects unrelated tracked deployment changes before synchronization", async () => {
  assert.throws(() => require_gitlink_only_deployment_state({
    deploymentRoot: "/fixture/hson-deploy",
    run: () => " M DEPLOYMENT.md",
  }), /unrelated tracked changes: DEPLOYMENT\.md/);
  let synchronized = false;
  await assert.rejects(run_latest_deploy_command({
    deploymentRoot: "/fixture/hson-deploy",
    withLock: async (_options, operation) => operation(),
    requireState: () => { throw new Error("unrelated tracked changes"); },
    synchronize: () => { synchronized = true; return []; },
  }), /unrelated tracked changes/);
  assert.equal(synchronized, false);
});
