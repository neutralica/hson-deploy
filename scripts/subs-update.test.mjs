import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { synchronize_source_gitlinks } from "./subs-update.mjs";

function git(cwd, arguments_) {
  return execFileSync("git", arguments_, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(cwd, message) {
  git(cwd, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

async function initialize_repository(directory, content) {
  git(directory, ["init", "-b", "main"]);
  await writeFile(join(directory, "source.txt"), content);
  git(directory, ["add", "source.txt"]);
  return commit(directory, "initial source");
}

async function fixture() {
  const owningRoot = await mkdtemp(join(tmpdir(), "hson-subs-update-"));
  const live = join(owningRoot, "hson-live");
  const demo = join(owningRoot, "hson-demo2");
  const deploymentRoot = join(owningRoot, "hson-deploy");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(live), mkdir(demo), mkdir(deploymentRoot)]));
  await initialize_repository(live, "live one\n");
  await initialize_repository(demo, "demo one\n");
  git(deploymentRoot, ["init", "-b", "main"]);
  git(deploymentRoot, ["-c", "protocol.file.allow=always", "submodule", "add", live, "hson-live"]);
  git(deploymentRoot, ["-c", "protocol.file.allow=always", "submodule", "add", demo, "hson-demo2"]);
  await writeFile(join(deploymentRoot, "README.md"), "fixture\n");
  git(deploymentRoot, ["add", "."]);
  commit(deploymentRoot, "pin sources");
  return { owningRoot, deploymentRoot, live, demo };
}

async function advance(directory, content) {
  await writeFile(join(directory, "source.txt"), content);
  git(directory, ["add", "source.txt"]);
  return commit(directory, "advance source");
}

for (const selected of [["hson-live"], ["hson-demo2"], ["hson-live", "hson-demo2"]]) {
  test(`subs:update advances ${selected.join(" and ")} to owning HEAD`, async () => {
    const context = await fixture();
    const commands = [];
    for (const name of selected) await advance(name === "hson-live" ? context.live : context.demo, `${name} two\n`);
    const run = (command, arguments_, options) => {
      commands.push([command, ...arguments_]);
      return execFileSync(command, arguments_, { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    };
    const results = synchronize_source_gitlinks({ deploymentRoot: context.deploymentRoot, owningRoot: context.owningRoot, run });
    for (const result of results) {
      const owner = result.name === "hson-live" ? context.live : context.demo;
      assert.equal(git(join(context.deploymentRoot, result.name), ["rev-parse", "HEAD"]), git(owner, ["rev-parse", "HEAD"]));
      assert.equal(git(join(context.deploymentRoot, result.name), ["status", "--porcelain"]), "");
      assert.equal(result.changed, selected.includes(result.name));
    }
    assert.equal(commands.some((entry) => entry.includes("push")), false);
  });
}

test("subs:update is a clean no-op when committed gitlinks already equal owning HEADs", async () => {
  const context = await fixture();
  const before = git(context.deploymentRoot, ["rev-parse", "HEAD"]);
  const results = synchronize_source_gitlinks({ deploymentRoot: context.deploymentRoot, owningRoot: context.owningRoot });
  assert.equal(results.every((result) => result.changed === false), true);
  assert.equal(git(context.deploymentRoot, ["status", "--porcelain"]), "");
  assert.equal(git(context.deploymentRoot, ["rev-parse", "HEAD"]), before);
});

test("subs:update rejects tracked owning changes and leaves all checkouts untouched", async () => {
  const context = await fixture();
  const liveIntended = await advance(context.live, "committed live source\n");
  await writeFile(join(context.demo, "source.txt"), "uncommitted\n");
  const liveBefore = git(join(context.deploymentRoot, "hson-live"), ["rev-parse", "HEAD"]);
  const demoBefore = git(join(context.deploymentRoot, "hson-demo2"), ["rev-parse", "HEAD"]);
  await assert.rejects(
    async () => synchronize_source_gitlinks({ deploymentRoot: context.deploymentRoot, owningRoot: context.owningRoot }),
    /commit or discard owning-repository changes first/,
  );
  assert.notEqual(liveBefore, liveIntended);
  assert.equal(git(join(context.deploymentRoot, "hson-live"), ["rev-parse", "HEAD"]), liveBefore);
  assert.equal(git(join(context.deploymentRoot, "hson-demo2"), ["rev-parse", "HEAD"]), demoBefore);
  assert.equal(git(context.deploymentRoot, ["status", "--porcelain"]), "");
});

test("subs:update selects committed source exactly without creating source commits", async () => {
  const context = await fixture();
  const intended = await advance(context.live, "committed live source\n");
  const ownerCommitCount = git(context.live, ["rev-list", "--count", "HEAD"]);
  synchronize_source_gitlinks({ deploymentRoot: context.deploymentRoot, owningRoot: context.owningRoot });
  assert.equal(git(join(context.deploymentRoot, "hson-live"), ["rev-parse", "HEAD"]), intended);
  assert.equal(await readFile(join(context.deploymentRoot, "hson-live/source.txt"), "utf8"), "committed live source\n");
  assert.equal(git(join(context.deploymentRoot, "hson-live"), ["status", "--porcelain"]), "");
  assert.equal(git(context.live, ["rev-list", "--count", "HEAD"]), ownerCommitCount);
});
