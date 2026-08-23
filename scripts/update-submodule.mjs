#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const deployRoot = path.resolve(scriptDir, "..");

const targets = {
  demo2: "hson-demo2",
  live: "hson-live",
};

const syncTargets = [
  { name: "hson-live", canonicalPath: path.resolve(deployRoot, "..", "hson-live") },
  { name: "hson-demo2", canonicalPath: path.resolve(deployRoot, "..", "hson-demo2") },
  { name: "intrastructure" },
];

function fail(message) {
  throw new Error(message);
}

function git(cwd, args, capture = false) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error) {
    fail(`Could not run git in ${cwd}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = capture ? result.stderr.trim() : "";
    fail(
      [
        `git ${args.join(" ")} failed in ${cwd}.`,
        stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return capture ? result.stdout.trim() : "";
}

function assertRepository(repoPath, label) {
  if (!existsSync(repoPath)) {
    fail(`${label} does not exist: ${repoPath}`);
  }

  const expectedRoot = realpathSync(repoPath);
  const actualRoot = realpathSync(
    git(repoPath, ["rev-parse", "--show-toplevel"], true),
  );

  if (actualRoot !== expectedRoot) {
    fail(
      `${label} is not the expected Git repository.\n` +
        `Expected: ${expectedRoot}\n` +
        `Actual:   ${actualRoot}`,
    );
  }
}

function status(repoPath) {
  return git(
    repoPath,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    true,
  );
}

function stagedFiles(repoPath) {
  const output = git(repoPath, ["diff", "--cached", "--name-only"], true);

  return output ? output.split("\n").filter(Boolean) : [];
}

function assertMainUpstream(repoPath, label) {
  const branch = git(repoPath, ["branch", "--show-current"], true);

  if (branch !== "main") {
    fail(`${label} must be on main; currently on ${branch || "(detached HEAD)"}.`);
  }

  const upstream = git(
    repoPath,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    true,
  );

  if (upstream !== "origin/main") {
    fail(
      `${label} must track origin/main; currently tracks ${upstream || "(none)"}.`,
    );
  }
}

function assertNoStagedChanges(repoPath, label) {
  const files = stagedFiles(repoPath);

  if (files.length > 0) {
    fail(
      `${label} already has staged changes.\n` +
        `Commit or unstage them before running submodule:update:\n\n` +
        files.map((file) => `  ${file}`).join("\n"),
    );
  }
}

function fetchMain(repoPath) {
  git(repoPath, ["fetch", "origin", "main"]);
}

function revisionRelationship(repoPath) {
  const output = git(
    repoPath,
    ["rev-list", "--left-right", "--count", "HEAD...origin/main"],
    true,
  );

  const [aheadText, behindText] = output.split(/\s+/);

  return {
    ahead: Number(aheadText),
    behind: Number(behindText),
  };
}

function synchronizeCleanCanonical(repoPath, label) {
  fetchMain(repoPath);

  const relationship = revisionRelationship(repoPath);

  if (relationship.ahead > 0) {
    fail(
      `${label} has ${relationship.ahead} local commit(s) not on origin/main.\n` +
        "Refusing to push pre-existing unpublished history automatically.",
    );
  }

  if (relationship.behind === 0) {
    return;
  }

  if (status(repoPath)) {
    fail(
      `${label} is ${relationship.behind} commit(s) behind origin/main and also has local changes.\n` +
        "Refusing to update history underneath a dirty working tree.",
    );
  }

  console.log(
    `\n${label} is ${relationship.behind} commit(s) behind origin/main; fast-forwarding.\n`,
  );

  git(repoPath, ["merge", "--ff-only", "origin/main"]);
}

function parentGitlink(repoName) {
  const output = git(
    deployRoot,
    ["ls-tree", "HEAD", "--", repoName],
    true,
  );

  if (!output) {
    fail(`Parent repository has no recorded gitlink for ${repoName}.`);
  }

  const fields = output.split(/\s+/);

  if (fields[0] !== "160000" || fields[1] !== "commit" || !fields[2]) {
    fail(`Unexpected gitlink record for ${repoName}: ${output}`);
  }

  return fields[2];
}

function originUrls(repoPath) {
  return {
    fetch: git(repoPath, ["remote", "get-url", "origin"], true),
    push: git(repoPath, ["remote", "get-url", "--push", "origin"], true),
  };
}

function configuredSubmoduleUrl(repoName) {
  return git(
    deployRoot,
    ["config", "--file", ".gitmodules", "--get", `submodule.${repoName}.url`],
    true,
  );
}

function assertPublishedMain(repoPath, label) {
  fetchMain(repoPath);

  const relationship = revisionRelationship(repoPath);

  if (relationship.ahead !== 0 || relationship.behind !== 0) {
    fail(
      `${label} HEAD must equal its published origin/main.\n` +
        `Ahead: ${relationship.ahead}; behind: ${relationship.behind}`,
    );
  }
}

function assertClean(repoPath, label) {
  const currentStatus = status(repoPath);

  if (currentStatus) {
    fail(`${label} must be clean:\n\n${currentStatus}`);
  }
}

function assertMatchingOrigin(repoPath, expectedUrl, label) {
  const actual = originUrls(repoPath);

  if (actual.fetch !== expectedUrl || actual.push !== expectedUrl) {
    fail(
      `${label} origin remote does not match the canonical submodule remote.\n` +
        `Expected: ${expectedUrl}\n` +
        `Fetch:    ${actual.fetch}\n` +
        `Push:     ${actual.push}`,
    );
  }
}

function synchronizePublishedSubmodules() {
  assertRepository(deployRoot, "hson-deploy");
  assertMainUpstream(deployRoot, "hson-deploy");
  assertClean(deployRoot, "hson-deploy");
  assertPublishedMain(deployRoot, "hson-deploy");

  const plans = [];

  for (const target of syncTargets) {
    const deploymentPath = path.join(deployRoot, target.name);
    const expectedRemote = configuredSubmoduleUrl(target.name);

    assertRepository(deploymentPath, `deployment ${target.name}`);
    assertClean(deploymentPath, `deployment ${target.name}`);
    assertMatchingOrigin(deploymentPath, expectedRemote, `deployment ${target.name}`);

    if (target.canonicalPath) {
      assertRepository(target.canonicalPath, `canonical ${target.name}`);
      assertClean(target.canonicalPath, `canonical ${target.name}`);
      assertMainUpstream(target.canonicalPath, `canonical ${target.name}`);
      assertMatchingOrigin(target.canonicalPath, expectedRemote, `canonical ${target.name}`);
      assertPublishedMain(target.canonicalPath, `canonical ${target.name}`);
    }

    const recordedGitlink = parentGitlink(target.name);
    const deploymentHead = git(deploymentPath, ["rev-parse", "HEAD"], true);

    if (recordedGitlink !== deploymentHead) {
      fail(
        `Deployment ${target.name} HEAD already differs from the parent gitlink.\n` +
          `Parent:    ${recordedGitlink}\n` +
          `Submodule: ${deploymentHead}\n` +
          "Refusing to replace an unexplained gitlink change.",
      );
    }

    fetchMain(deploymentPath);
    const relationship = revisionRelationship(deploymentPath);

    if (relationship.ahead !== 0) {
      fail(
        `Deployment ${target.name} has ${relationship.ahead} unpublished local commit(s).\n` +
          "Refusing to discard or replace local history.",
      );
    }

    plans.push({
      deploymentPath,
      name: target.name,
      behind: relationship.behind,
      publishedCommit: git(deploymentPath, ["rev-parse", "origin/main"], true),
    });
  }

  const changedGitlinks = [];

  for (const plan of plans) {
    if (plan.behind === 0) {
      console.log(`${plan.name}: already pinned to published origin/main.`);
      continue;
    }

    console.log(`${plan.name}: advancing ${plan.behind} commit(s) to ${plan.publishedCommit}.`);
    git(plan.deploymentPath, ["switch", "--detach", plan.publishedCommit]);
    assertClean(plan.deploymentPath, `deployment ${plan.name}`);
    changedGitlinks.push(plan.name);
  }

  for (const repoName of changedGitlinks) {
    git(deployRoot, ["add", "--", repoName]);
  }

  const staged = stagedFiles(deployRoot);

  if (
    staged.length !== changedGitlinks.length ||
    staged.some((file) => !changedGitlinks.includes(file))
  ) {
    fail(
      "Unexpected parent files became staged:\n\n" +
        (staged.length > 0 ? staged.map((file) => `  ${file}`).join("\n") : "  (none)"),
    );
  }

  console.log("\nSubmodule sync complete.");
  if (changedGitlinks.length === 0) {
    console.log("All deployment gitlinks already match published origin/main.");
  } else {
    console.log(`Staged parent gitlinks: ${changedGitlinks.join(", ")}`);
  }
  console.log("The hson-deploy repository was NOT committed or pushed.");
}

async function confirm(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(
      "submodule:update requires an interactive terminal for confirmation.",
    );
  }

  const interface_ = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = (await interface_.question(`${question} [y/N] `))
      .trim()
      .toLowerCase();

    return answer === "y" || answer === "yes";
  } finally {
    interface_.close();
  }
}

async function commitCanonical(
  canonicalPath,
  repoName,
  commitMessage,
) {
  const currentStatus = status(canonicalPath);

  if (!currentStatus) {
    console.log(`\n${repoName}: canonical checkout has no source changes to commit.`);
    return git(canonicalPath, ["rev-parse", "HEAD"], true);
  }

  git(canonicalPath, ["diff", "--check"]);

  console.log(`\n${repoName}: canonical changes\n`);
  git(canonicalPath, ["status", "--short"]);
  console.log("");
  git(canonicalPath, ["diff", "--stat"]);
  console.log("");
  git(canonicalPath, ["diff"]);

  const untracked = git(
    canonicalPath,
    ["ls-files", "--others", "--exclude-standard"],
    true,
  );

  if (untracked) {
    console.log("\nUntracked files that will be included:\n");
    console.log(untracked);
  }

  if (
    !(await confirm(
      `Stage all canonical ${repoName} changes for "${commitMessage}"?`,
    ))
  ) {
    fail("Aborted before staging.");
  }

  let stagedByScript = false;

  try {
    git(canonicalPath, ["add", "-A"]);
    stagedByScript = true;

    git(canonicalPath, ["diff", "--cached", "--check"]);

    console.log(`\n${repoName}: exact staged commit\n`);
    git(canonicalPath, ["diff", "--cached", "--stat"]);
    console.log("");
    git(canonicalPath, ["diff", "--cached"]);

    if (
      !(await confirm(
        `Commit and push exactly this ${repoName} diff as "${commitMessage}"?`,
      ))
    ) {
      git(canonicalPath, ["restore", "--staged", "--", "."]);
      stagedByScript = false;
      fail("Aborted before commit; working-tree changes were preserved.");
    }

    git(canonicalPath, ["commit", "-m", commitMessage]);
    stagedByScript = false;
  } catch (error) {
    if (stagedByScript) {
      try {
        git(canonicalPath, ["restore", "--staged", "--", "."]);
      } catch {
        console.error(
          "\nWarning: automatic index cleanup failed; inspect the canonical repository index.",
        );
      }
    }

    throw error;
  }

  const commit = git(canonicalPath, ["rev-parse", "HEAD"], true);

  if (status(canonicalPath)) {
    fail(
      `${repoName} became dirty after commit, possibly due to a hook.\n` +
        "Refusing to update the deployment submodule.",
    );
  }

  console.log(`\nPushing canonical ${repoName} ${commit}...\n`);
  git(canonicalPath, ["push", "origin", "main"]);

  fetchMain(canonicalPath);

  const publishedCommit = git(
    canonicalPath,
    ["rev-parse", "origin/main"],
    true,
  );

  if (publishedCommit !== commit) {
    fail(
      `${repoName} push did not leave origin/main at the expected commit.\n` +
        `Expected: ${commit}\n` +
        `Actual:   ${publishedCommit}`,
    );
  }

  return commit;
}

function updateDeploymentSubmodule(
  deploymentPath,
  repoName,
  canonicalCommit,
) {
  console.log(`\nUpdating deployment ${repoName} to ${canonicalCommit}...\n`);

  fetchMain(deploymentPath);

  const deploymentRemoteCommit = git(
    deploymentPath,
    ["rev-parse", "origin/main"],
    true,
  );

  if (deploymentRemoteCommit !== canonicalCommit) {
    fail(
      `Deployment ${repoName} origin/main does not match canonical origin/main.\n` +
        `Canonical:  ${canonicalCommit}\n` +
        `Deployment: ${deploymentRemoteCommit}\n` +
        "Refusing to guess which remote history is authoritative.",
    );
  }

  git(deploymentPath, ["switch", "--detach", canonicalCommit]);

  const actualCommit = git(
    deploymentPath,
    ["rev-parse", "HEAD"],
    true,
  );

  if (actualCommit !== canonicalCommit) {
    fail(
      `Deployment ${repoName} did not reach the requested commit.\n` +
        `Expected: ${canonicalCommit}\n` +
        `Actual:   ${actualCommit}`,
    );
  }

  const deploymentStatus = status(deploymentPath);

  if (deploymentStatus) {
    fail(
      `Deployment ${repoName} is dirty after switching commits:\n\n${deploymentStatus}`,
    );
  }
}

async function main() {
  const [targetName, ...messageParts] = process.argv.slice(2);

  if (targetName === "sync") {
    if (messageParts.length > 0) {
      fail("Usage:\n  npm run submodules:sync");
    }

    synchronizePublishedSubmodules();
    return;
  }

  const commitMessage = messageParts.join(" ").trim();

  if (!targetName || !targets[targetName]) {
    fail(
      "Usage:\n" +
        '  npm run submodule:update -- demo2 "commit message"\n' +
        '  npm run submodule:update -- live "commit message"',
    );
  }

  if (!commitMessage) {
    fail("A non-empty canonical repository commit message is required.");
  }

  const repoName = targets[targetName];
  const canonicalPath = path.resolve(deployRoot, "..", repoName);
  const deploymentPath = path.join(deployRoot, repoName);

  assertRepository(deployRoot, "hson-deploy");
  assertRepository(canonicalPath, `canonical ${repoName}`);
  assertRepository(deploymentPath, `deployment ${repoName}`);

  assertMainUpstream(deployRoot, "hson-deploy");
  assertMainUpstream(canonicalPath, `canonical ${repoName}`);

  assertNoStagedChanges(deployRoot, "hson-deploy");
  assertNoStagedChanges(canonicalPath, `canonical ${repoName}`);

  const deploymentStatus = status(deploymentPath);

  if (deploymentStatus) {
    fail(
      `Deployment submodule ${repoName} is dirty:\n\n` +
        `${deploymentStatus}\n\n` +
        `Source changes must be authored in ../${repoName}.\n` +
        "Refusing to modify or clean the submodule automatically.",
    );
  }

  const recordedGitlink = parentGitlink(repoName);
  const deploymentHead = git(
    deploymentPath,
    ["rev-parse", "HEAD"],
    true,
  );

  if (recordedGitlink !== deploymentHead) {
    fail(
      `Deployment ${repoName} HEAD already differs from the parent gitlink.\n` +
        `Parent:    ${recordedGitlink}\n` +
        `Submodule: ${deploymentHead}\n` +
        "Refusing to build on an unexplained gitlink change.",
    );
  }

  /*
   * CHANGED: require the parent itself to start from published main.
   * Parent working-tree changes are allowed, but stale/divergent history is not.
   */
  fetchMain(deployRoot);

  const parentRelationship = revisionRelationship(deployRoot);

  if (parentRelationship.ahead !== 0 || parentRelationship.behind !== 0) {
    fail(
      "hson-deploy HEAD must equal origin/main before updating a submodule.\n" +
        `Ahead: ${parentRelationship.ahead}; behind: ${parentRelationship.behind}`,
    );
  }

  /*
   * CHANGED: fast-forward the canonical checkout automatically only when clean.
   * Dirty + behind, ahead, or divergent states fail closed.
   */
  synchronizeCleanCanonical(
    canonicalPath,
    `canonical ${repoName}`,
  );

  const canonicalCommit = await commitCanonical(
    canonicalPath,
    repoName,
    commitMessage,
  );

  updateDeploymentSubmodule(
    deploymentPath,
    repoName,
    canonicalCommit,
  );

  /*
   * CHANGED: stage only the parent gitlink. Do not create a parent commit;
   * deployment-owned changes should be reviewed and committed together later.
   */
  git(deployRoot, ["add", "--", repoName]);

  const staged = stagedFiles(deployRoot);

  if (staged.length > 1 || (staged.length === 1 && staged[0] !== repoName)) {
    fail(
      "Unexpected parent files became staged:\n\n" +
        staged.map((file) => `  ${file}`).join("\n"),
    );
  }

  console.log("\nSubmodule reconciliation complete.");
  console.log(`Canonical ${repoName}: ${canonicalCommit}`);
  console.log(`Deployment ${repoName}: ${canonicalCommit}`);

  if (staged.length === 1) {
    console.log(`Parent gitlink staged: ${repoName}`);
    console.log("\nThe hson-deploy repository was NOT committed or pushed.");
  } else {
    console.log("Parent gitlink was already current; nothing was staged.");
  }
}

main().catch((error) => {
  const command = process.argv[2] === "sync" ? "submodules:sync" : "submodule:update";
  console.error(`\n${command}: ${error.message}\n`);
  process.exitCode = 1;
});
