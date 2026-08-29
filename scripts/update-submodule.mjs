#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const deployRoot = path.resolve(process.env.HSON_DEPLOY_ROOT || path.resolve(scriptDir, ".."));
const targets = ["hson-demo2", "hson-live"].map((name) => ({
	name,
	canonicalPath: path.resolve(deployRoot, "..", name),
	deploymentPath: path.resolve(deployRoot, name),
}));

function fail(message) {
	throw new Error(message);
}

function git(cwd, args, capture = false) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.error) fail(`Could not run git in ${cwd}: ${result.error.message}`);
	if (result.status !== 0) {
		const details = capture ? [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") : "";
		fail([`git ${args.join(" ")} failed in ${cwd}.`, details].filter(Boolean).join("\n"));
	}
	// Porcelain status uses meaningful leading spaces for its index/worktree columns.
	return capture ? result.stdout.trimEnd() : "";
}

function assertRepository(repoPath, label) {
	if (!existsSync(repoPath)) fail(`${label} does not exist: ${repoPath}`);
	const expected = realpathSync(repoPath);
	const actual = realpathSync(git(repoPath, ["rev-parse", "--show-toplevel"], true));
	if (actual !== expected) {
		fail(`${label} is not the expected Git repository.\nExpected: ${expected}\nActual:   ${actual}`);
	}
}

function status(repoPath) {
	return git(repoPath, ["status", "--porcelain=v1", "--untracked-files=all"], true);
}

function statusPath(line) {
	return line.slice(3).replace(/^.* -> /, "");
}

function changedPaths(currentStatus) {
	return currentStatus.split("\n").filter(Boolean).map(statusPath).map((file) => `  ${file}`).join("\n");
}

function assertClean(repoPath, label, context = "") {
	const currentStatus = status(repoPath);
	if (currentStatus) {
		fail(`${label} must be clean.\nChanged paths:\n${changedPaths(currentStatus)}${context ? `\n${context}` : ""}`);
	}
}

function pathsFromGit(args) {
	return git(deployRoot, [...args, "-z"], true).split("\0").filter(Boolean);
}

function assertParentStateReadable() {
	const unmerged = pathsFromGit(["diff", "--name-only", "--diff-filter=U"]);
	if (unmerged.length) {
		fail("Cannot safely interpret hson-deploy while it contains unresolved conflicts.\nConflicted paths:\n" +
			unmerged.map((file) => `  ${file}`).join("\n"));
	}
	const metadataChanges = new Set([
		...pathsFromGit(["diff", "--name-only", "--", ".gitmodules"]),
		...pathsFromGit(["diff", "--cached", "--name-only", "--", ".gitmodules"]),
	]);
	if (metadataChanges.size) {
		fail("Cannot synchronize deployment submodules while .gitmodules has local changes.\nChanged paths:\n  .gitmodules");
	}
	const stagedGitlinks = pathsFromGit(["diff", "--cached", "--name-only", "--", ...targets.map(({ name }) => name)]);
	if (stagedGitlinks.length) {
		fail("Cannot synchronize deployment submodules because managed gitlinks already have staged changes.\nChanged paths:\n" +
			stagedGitlinks.map((file) => `  ${file}`).join("\n"));
	}
}

function assertMainUpstream(repoPath, label) {
	const branch = git(repoPath, ["branch", "--show-current"], true);
	if (branch !== "main") fail(`${label} must be on main; currently on ${branch || "(detached HEAD)"}.`);
	const upstream = git(repoPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], true);
	if (upstream !== "origin/main") {
		fail(`${label} must track expected upstream origin/main; currently tracks ${upstream || "(none)"}.`);
	}
}

function fetchMain(repoPath) {
	git(repoPath, ["fetch", "origin", "main"]);
}

function relationship(repoPath) {
	const [ahead, behind] = git(repoPath, ["rev-list", "--left-right", "--count", "HEAD...origin/main"], true).split(/\s+/);
	return { ahead: Number(ahead), behind: Number(behind) };
}

function originUrls(repoPath) {
	return {
		fetch: git(repoPath, ["remote", "get-url", "origin"], true),
		push: git(repoPath, ["remote", "get-url", "--push", "origin"], true),
	};
}

function configuredUrl(name) {
	return git(deployRoot, ["config", "--file", ".gitmodules", "--get", `submodule.${name}.url`], true);
}

function assertMatchingOrigin(repoPath, expected, label) {
	const actual = originUrls(repoPath);
	if (actual.fetch !== expected || actual.push !== expected) {
		fail(`${label} origin does not match the managed remote.\nExpected: ${expected}\nFetch:    ${actual.fetch}\nPush:     ${actual.push}`);
	}
}

function gitlink(revision, name) {
	const entry = git(deployRoot, ["ls-tree", revision, "--", name], true);
	const match = /^160000 commit ([0-9a-f]{40})\t/.exec(entry);
	if (!match) fail(`Parent repository has no valid gitlink for ${name} at ${revision}.`);
	return match[1];
}

function synchronizeParent() {
	assertMainUpstream(deployRoot, "hson-deploy");
	fetchMain(deployRoot);
	const state = relationship(deployRoot);
	if (state.ahead > 0) {
		fail(`hson-deploy contains pre-existing unpublished or divergent commits.\nAhead: ${state.ahead}; behind: ${state.behind}`);
	}
	if (state.behind > 0) {
		console.log(`hson-deploy is ${state.behind} commit(s) behind origin/main; fast-forwarding.`);
		git(deployRoot, ["merge", "--ff-only", "origin/main"]);
	}
}

function validateTarget(target) {
	const expectedRemote = configuredUrl(target.name);
	assertRepository(target.canonicalPath, `canonical ${target.name}`);
	assertClean(target.canonicalPath, `canonical ${target.name}`);
	assertMainUpstream(target.canonicalPath, `canonical ${target.name}`);
	assertMatchingOrigin(target.canonicalPath, expectedRemote, `canonical ${target.name}`);
	assertRepository(target.deploymentPath, `deployment submodule ${target.name}`);
	assertClean(target.deploymentPath, `deployment submodule ${target.name}`,
		`Canonical sibling: ${target.canonicalPath}`);
	assertMatchingOrigin(target.deploymentPath, expectedRemote, `deployment submodule ${target.name}`);
	fetchMain(target.canonicalPath);
	const state = relationship(target.canonicalPath);
	if (state.ahead > 0 && state.behind > 0) {
		fail(`canonical ${target.name} has diverged from origin/main.\nAhead: ${state.ahead}; behind: ${state.behind}`);
	}
	return {
		...target,
		state,
		deploymentHead: git(target.deploymentPath, ["rev-parse", "HEAD"], true),
		recordedGitlink: gitlink("HEAD", target.name),
		desiredCommit: state.behind > 0
			? git(target.canonicalPath, ["rev-parse", "origin/main"], true)
			: git(target.canonicalPath, ["rev-parse", "HEAD"], true),
	};
}

function assertParentGitlinksReconcilable(plans) {
	for (const plan of plans) {
		if (plan.deploymentHead !== plan.recordedGitlink && plan.deploymentHead !== plan.desiredCommit) {
			fail(`Cannot update ${plan.name} deployment submodule: parent gitlink already has an unknown local change.\n` +
				`Recorded gitlink: ${plan.recordedGitlink}\n` +
				`Submodule HEAD:   ${plan.deploymentHead}\n` +
				`Canonical HEAD:   ${plan.desiredCommit}`);
		}
	}
}

function makeCanonicalAvailable(plan) {
	if (plan.state.behind > 0) {
		console.log(`${plan.name}: canonical checkout is ${plan.state.behind} commit(s) behind; fast-forwarding.`);
		git(plan.canonicalPath, ["merge", "--ff-only", "origin/main"]);
	}
	if (plan.state.ahead > 0) {
		const expected = git(plan.canonicalPath, ["rev-parse", "HEAD"], true);
		console.log(`${plan.name}: publishing ${plan.state.ahead} already-committed fast-forward commit(s).`);
		git(plan.canonicalPath, ["push", "origin", "HEAD:main"]);
		fetchMain(plan.canonicalPath);
		const actual = git(plan.canonicalPath, ["rev-parse", "origin/main"], true);
		if (actual !== expected) fail(`${plan.name} push did not publish exact canonical HEAD.\nExpected: ${expected}\nActual:   ${actual}`);
	}
	assertClean(plan.canonicalPath, `canonical ${plan.name}`);
	return git(plan.canonicalPath, ["rev-parse", "HEAD"], true);
}

function reconcile(plan, canonicalCommit) {
	fetchMain(plan.deploymentPath);
	git(plan.deploymentPath, ["cat-file", "-e", `${canonicalCommit}^{commit}`]);
	const checkoutChanged = plan.deploymentHead !== canonicalCommit;
	if (checkoutChanged) {
		console.log(`${plan.name}: ${plan.deploymentHead.slice(0, 7)} → ${canonicalCommit.slice(0, 7)}`);
		git(plan.deploymentPath, ["switch", "--detach", canonicalCommit]);
	}
	assertClean(plan.deploymentPath, `deployment submodule ${plan.name}`,
		`Canonical sibling: ${plan.canonicalPath}`);
	const actual = git(plan.deploymentPath, ["rev-parse", "HEAD"], true);
	if (actual !== canonicalCommit) {
		fail(`${plan.name} did not reach canonical HEAD.\nCanonical:  ${canonicalCommit}\nDeployment: ${actual}`);
	}
	return { checkoutChanged, gitlinkChanged: plan.recordedGitlink !== canonicalCommit };
}

function commitGitlinks(updates) {
	for (const { name } of updates) git(deployRoot, ["add", "--", name]);
	const staged = git(deployRoot, ["diff", "--cached", "--name-only"], true).split("\n").filter(Boolean);
	const expected = updates.map(({ name }) => name);
	if (staged.length !== expected.length || staged.some((file) => !expected.includes(file))) {
		fail("Refusing to commit unexpected parent paths.\nStaged paths:\n" +
			staged.map((file) => `  ${file}`).join("\n"));
	}
	const body = updates.map(({ name, commit }) => `${name}: ${commit.slice(0, 7)}`).join("\n");
	git(deployRoot, ["commit", "-m", "Update deployment submodules", "-m", body]);
	for (const update of updates) {
		const recorded = gitlink("HEAD", update.name);
		if (recorded !== update.commit) {
			fail(`Committed ${update.name} gitlink does not match canonical HEAD.\nCanonical: ${update.commit}\nGitlink:   ${recorded}`);
		}
	}
}

function pushParent() {
	assertClean(deployRoot, "hson-deploy after bookkeeping commit");
	fetchMain(deployRoot);
	const state = relationship(deployRoot);
	if (state.ahead === 0 || state.behind !== 0) {
		fail(`Generated hson-deploy commit is not an ordinary fast-forward push.\nAhead: ${state.ahead}; behind: ${state.behind}`);
	}
	git(deployRoot, ["push", "origin", "HEAD:main"]);
	fetchMain(deployRoot);
	if (git(deployRoot, ["rev-parse", "HEAD"], true) !== git(deployRoot, ["rev-parse", "origin/main"], true)) {
		fail("hson-deploy push did not publish the exact bookkeeping commit.");
	}
}

function main() {
	if (process.argv.length > 2) fail("Usage:\n  npm run subs:update");
	assertRepository(deployRoot, "hson-deploy");
	const parentWasDirty = Boolean(status(deployRoot));
	assertParentStateReadable();
	synchronizeParent();
	assertParentStateReadable();

	// Validate every repository and authority relationship before mutating any checkout.
	const plans = targets.map(validateTarget);
	assertParentGitlinksReconcilable(plans);
	const canonical = new Map(plans.map((plan) => [plan.name, makeCanonicalAvailable(plan)]));
	const updates = [];
	for (const plan of plans) {
		const commit = canonical.get(plan.name);
		const result = reconcile(plan, commit);
		if (result.gitlinkChanged) updates.push({ name: plan.name, commit, checkoutChanged: result.checkoutChanged });
	}
	if (!updates.length) {
		console.log("All managed deployment submodules already match canonical HEADs; no updates required.");
		return;
	}
	if (parentWasDirty) {
		const synchronized = updates.some(({ checkoutChanged }) => checkoutChanged);
		console.log(synchronized
			? "Deployment parent contains unrelated changes; submodules were synchronized but bookkeeping commit was skipped."
			: "Deployment submodules already match canonical HEADs; existing gitlink updates remain uncommitted because the parent contains other changes.");
		console.log(`Uncommitted gitlink updates: ${updates.map(({ name, commit }) => `${name} (${commit.slice(0, 7)})`).join(", ")}.`);
		return;
	}
	commitGitlinks(updates);
	pushParent();
	console.log(`Submodule reconciliation committed and pushed: ${updates.map(({ name }) => name).join(", ")}.`);
}

try {
	main();
} catch (error) {
	console.error(`\nsubs:update: ${error.message}\n`);
	process.exitCode = 1;
}
