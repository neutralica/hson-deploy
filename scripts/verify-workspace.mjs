import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packages = ["hson-live", "hson-demo2"];

function git(args, cwd = root) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function requireClean(directory) {
  if (git(["status", "--porcelain"], directory) !== "") {
    throw new Error(`${directory === root ? "deployment workspace" : directory} is not clean.`);
  }
}

function requireRevision(directory, expected, label) {
  requireClean(directory);
  const actual = git(["rev-parse", "HEAD"], directory);
  if (actual !== expected) throw new Error(`${label} revision ${actual} does not match packaged revision ${expected}.`);
}

try {
  requireClean(root);

  for (const packageName of packages) {
    const directory = resolve(root, packageName);
    if (!existsSync(resolve(directory, ".git"))) {
      throw new Error(`${packageName} checkout is missing.`);
    }
    const treeEntry = git(["ls-tree", "HEAD", "--", packageName]);
    const expected = /^160000 commit ([0-9a-f]{40})\t/.exec(treeEntry)?.[1];
    if (expected === undefined) {
      throw new Error(`${packageName} is not pinned as a gitlink in the deployment workspace.`);
    }
    requireRevision(directory, expected, packageName);
  }

  console.log("workspace verification: hson-live and hson-demo2 match clean deployment gitlinks");
} catch (error) {
  console.error(`workspace verification failed: ${error.message}`);
  process.exit(1);
}
