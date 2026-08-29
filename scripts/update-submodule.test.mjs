import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "update-submodule.mjs");
const names = ["hson-demo2", "hson-live"];

function git(cwd, ...args) {
	return execFileSync("git", ["-c", "protocol.file.allow=always", ...args], {
		cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function configure(repo) {
	git(repo, "config", "user.name", "Fixture Operator");
	git(repo, "config", "user.email", "fixture@example.invalid");
}

function fixture() {
	const root = mkdtempSync(path.join(tmpdir(), "hson-subs-update-"));
	const remotes = path.join(root, "remotes");
	mkdirSync(remotes);
	const canonical = {};
	const remote = {};
	for (const name of names) {
		remote[name] = path.join(remotes, `${name}.git`);
		mkdirSync(remote[name]);
		git(remote[name], "init", "--bare", "--initial-branch=main");
		canonical[name] = path.join(root, name);
		git(root, "clone", remote[name], canonical[name]);
		configure(canonical[name]);
		writeFileSync(path.join(canonical[name], "source.txt"), `${name} initial\n`);
		git(canonical[name], "add", "source.txt");
		git(canonical[name], "commit", "-m", "Initial source");
		git(canonical[name], "push", "-u", "origin", "main");
	}
	const parentRemote = path.join(remotes, "hson-deploy.git");
	mkdirSync(parentRemote);
	git(parentRemote, "init", "--bare", "--initial-branch=main");
	const deploy = path.join(root, "hson-deploy");
	git(root, "clone", parentRemote, deploy);
	configure(deploy);
	for (const name of names) git(deploy, "submodule", "add", remote[name], name);
	git(deploy, "commit", "-m", "Initial deployment pins");
	git(deploy, "push", "-u", "origin", "main");
	return {
		root, deploy, canonical, remote, parentRemote,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function sourceCommit(f, name, push = true) {
	const repo = f.canonical[name];
	appendFileSync(path.join(repo, "source.txt"), "canonical update\n");
	git(repo, "add", "source.txt");
	git(repo, "commit", "-m", "Canonical update");
	if (push) git(repo, "push", "origin", "main");
	return git(repo, "rev-parse", "HEAD");
}

function run(f, args = []) {
	return spawnSync(process.execPath, [script, ...args], {
		cwd: f.deploy,
		encoding: "utf8",
		env: { ...process.env, GIT_ALLOW_PROTOCOL: "file", HSON_DEPLOY_ROOT: f.deploy },
	});
}

function out(result) {
	return `${result.stdout}\n${result.stderr}`;
}

function assertPins(f, updates) {
	for (const name of names) {
		const source = git(f.canonical[name], "rev-parse", "HEAD");
		assert.equal(git(path.join(f.deploy, name), "rev-parse", "HEAD"), source);
		assert.equal(git(f.deploy, "ls-tree", "HEAD", "--", name).split(/\s+/)[2], source);
	}
	assert.equal(git(f.deploy, "rev-parse", "HEAD"), git(f.parentRemote, "rev-parse", "main"));
	assert.equal(git(f.deploy, "status", "--porcelain=v1", "--untracked-files=all"), "");
	const message = git(f.deploy, "log", "-1", "--format=%B");
	assert.match(message, /^Update deployment submodules\n\n/);
	for (const [name, commit] of updates) assert.ok(message.includes(`${name}: ${commit.slice(0, 7)}`));
}

function assertUncommittedPins(f, updates, parentHead) {
	assert.equal(git(f.deploy, "rev-parse", "HEAD"), parentHead);
	assert.equal(git(f.parentRemote, "rev-parse", "main"), parentHead);
	for (const [name, commit] of updates) {
		assert.equal(git(path.join(f.deploy, name), "rev-parse", "HEAD"), commit);
		assert.notEqual(git(f.deploy, "ls-tree", "HEAD", "--", name).split(/\s+/)[2], commit);
	}
}

function addTrackedParentFile(f) {
	writeFileSync(path.join(f.deploy, "DEPLOYMENT.md"), "initial\n");
	git(f.deploy, "add", "DEPLOYMENT.md");
	git(f.deploy, "commit", "-m", "Add deployment notes");
	git(f.deploy, "push", "origin", "main");
}

test("already synchronized is a no-op with no empty commit", () => {
	const f = fixture();
	try {
		const before = git(f.deploy, "rev-parse", "HEAD");
		const result = run(f);
		assert.equal(result.status, 0, out(result));
		assert.match(out(result), /no updates required/i);
		assert.equal(git(f.deploy, "rev-parse", "HEAD"), before);
		assert.equal(git(f.parentRemote, "rev-parse", "main"), before);
	} finally { f.cleanup(); }
});

for (const stale of [["hson-demo2"], ["hson-live"], names]) {
	test(`updates stale managed submodules: ${stale.join(", ")}`, () => {
		const f = fixture();
		try {
			const updates = stale.map((name) => [name, sourceCommit(f, name)]);
			const result = run(f);
			assert.equal(result.status, 0, out(result));
			assertPins(f, updates);
		} finally { f.cleanup(); }
	});
}

test("dirty canonical source reports the changed path", () => {
	const f = fixture();
	try {
		appendFileSync(path.join(f.canonical["hson-demo2"], "source.txt"), "dirty\n");
		const result = run(f);
		assert.notEqual(result.status, 0);
		assert.match(out(result), /canonical hson-demo2 must be clean/);
		assert.match(out(result), /source\.txt/);
	} finally { f.cleanup(); }
});

test("dirty deployment reports path and canonical sibling", () => {
	const f = fixture();
	try {
		const beforeDemo = git(path.join(f.deploy, "hson-demo2"), "rev-parse", "HEAD");
		const beforeLive = git(path.join(f.deploy, "hson-live"), "rev-parse", "HEAD");
		sourceCommit(f, "hson-demo2");
		sourceCommit(f, "hson-live");
		appendFileSync(path.join(f.deploy, "hson-live", "source.txt"), "residue\n");
		const dirtyBefore = git(path.join(f.deploy, "hson-live"), "diff", "--", "source.txt");
		const result = run(f);
		assert.notEqual(result.status, 0);
		assert.match(out(result), /deployment submodule hson-live must be clean/);
		assert.match(out(result), /source\.txt/);
		assert.ok(out(result).includes(f.canonical["hson-live"]));
		assert.equal(git(path.join(f.deploy, "hson-demo2"), "rev-parse", "HEAD"), beforeDemo);
		assert.equal(git(path.join(f.deploy, "hson-live"), "rev-parse", "HEAD"), beforeLive);
		assert.equal(git(path.join(f.deploy, "hson-live"), "diff", "--", "source.txt"), dirtyBefore);
	} finally { f.cleanup(); }
});

test("unrelated modified parent work allows synchronization and skips bookkeeping", () => {
	const f = fixture();
	try {
		addTrackedParentFile(f);
		const before = git(f.deploy, "rev-parse", "HEAD");
		const commit = sourceCommit(f, "hson-live");
		appendFileSync(path.join(f.deploy, "DEPLOYMENT.md"), "unrelated\n");
		const dirtyBefore = git(f.deploy, "diff", "--", "DEPLOYMENT.md");
		const result = run(f);
		assert.equal(result.status, 0, out(result));
		assert.match(out(result), /bookkeeping commit was skipped/);
		assertUncommittedPins(f, [["hson-live", commit]], before);
		assert.equal(git(f.deploy, "diff", "--", "DEPLOYMENT.md"), dirtyBefore);
	} finally { f.cleanup(); }
});

test("unrelated untracked parent work is untouched while synchronization succeeds", () => {
	const f = fixture();
	try {
		const before = git(f.deploy, "rev-parse", "HEAD");
		const commit = sourceCommit(f, "hson-live");
		writeFileSync(path.join(f.deploy, "notes.txt"), "unrelated\n");
		const result = run(f);
		assert.equal(result.status, 0, out(result));
		assert.match(out(result), /bookkeeping commit was skipped/);
		assertUncommittedPins(f, [["hson-live", commit]], before);
		assert.equal(git(f.deploy, "status", "--short", "--", "notes.txt"), "?? notes.txt");
	} finally { f.cleanup(); }
});

test("unrelated staged parent work remains staged and is not committed", () => {
	const f = fixture();
	try {
		addTrackedParentFile(f);
		const before = git(f.deploy, "rev-parse", "HEAD");
		const commit = sourceCommit(f, "hson-live");
		appendFileSync(path.join(f.deploy, "DEPLOYMENT.md"), "staged user work\n");
		git(f.deploy, "add", "DEPLOYMENT.md");
		const stagedBefore = git(f.deploy, "diff", "--cached", "--", "DEPLOYMENT.md");
		const result = run(f);
		assert.equal(result.status, 0, out(result));
		assert.match(out(result), /bookkeeping commit was skipped/);
		assertUncommittedPins(f, [["hson-live", commit]], before);
		assert.equal(git(f.deploy, "diff", "--cached", "--", "DEPLOYMENT.md"), stagedBefore);
		assert.equal(git(f.deploy, "diff", "--cached", "--name-only"), "DEPLOYMENT.md");
	} finally { f.cleanup(); }
});

test("unknown relevant gitlink change blocks before reconciliation", () => {
	const f = fixture();
	try {
		const intermediate = sourceCommit(f, "hson-live");
		const desired = sourceCommit(f, "hson-live");
		git(path.join(f.deploy, "hson-live"), "fetch", "origin", "main");
		git(path.join(f.deploy, "hson-live"), "switch", "--detach", intermediate);
		const result = run(f);
		assert.notEqual(result.status, 0);
		assert.match(out(result), /parent gitlink already has an unknown local change/);
		assert.match(out(result), new RegExp(intermediate));
		assert.match(out(result), new RegExp(desired));
		assert.equal(git(path.join(f.deploy, "hson-live"), "rev-parse", "HEAD"), intermediate);
	} finally { f.cleanup(); }
});

test("staged managed gitlink blocks without disturbing the index", () => {
	const f = fixture();
	try {
		const commit = sourceCommit(f, "hson-live");
		git(path.join(f.deploy, "hson-live"), "fetch", "origin", "main");
		git(path.join(f.deploy, "hson-live"), "switch", "--detach", commit);
		git(f.deploy, "add", "--", "hson-live");
		const stagedBefore = git(f.deploy, "diff", "--cached", "--", "hson-live");
		const result = run(f);
		assert.notEqual(result.status, 0);
		assert.match(out(result), /managed gitlinks already have staged changes/);
		assert.match(out(result), /hson-live/);
		assert.equal(git(f.deploy, "diff", "--cached", "--", "hson-live"), stagedBefore);
	} finally { f.cleanup(); }
});

test("local .gitmodules changes block as relevant synchronization metadata", () => {
	const f = fixture();
	try {
		appendFileSync(path.join(f.deploy, ".gitmodules"), "# local change\n");
		const dirtyBefore = git(f.deploy, "diff", "--", ".gitmodules");
		const result = run(f);
		assert.notEqual(result.status, 0);
		assert.match(out(result), /\.gitmodules has local changes/);
		assert.equal(git(f.deploy, "diff", "--", ".gitmodules"), dirtyBefore);
	} finally { f.cleanup(); }
});

test("dirty-parent synchronization is idempotent with an uncommitted desired gitlink", () => {
	const f = fixture();
	try {
		const commit = sourceCommit(f, "hson-live");
		writeFileSync(path.join(f.deploy, "notes.txt"), "unrelated\n");
		const first = run(f);
		assert.equal(first.status, 0, out(first));
		const statusAfterFirst = git(f.deploy, "status", "--porcelain=v1", "--untracked-files=all");
		const second = run(f);
		assert.equal(second.status, 0, out(second));
		assert.match(out(second), /already match canonical HEADs/);
		assert.match(out(second), /gitlink updates remain uncommitted/);
		assert.equal(git(f.deploy, "status", "--porcelain=v1", "--untracked-files=all"), statusAfterFirst);
		assert.equal(git(path.join(f.deploy, "hson-live"), "rev-parse", "HEAD"), commit);
	} finally { f.cleanup(); }
});

test("safe unpushed canonical commit is pushed before reconciliation", () => {
	const f = fixture();
	try {
		const commit = sourceCommit(f, "hson-demo2", false);
		assert.notEqual(git(f.remote["hson-demo2"], "rev-parse", "main"), commit);
		const result = run(f);
		assert.equal(result.status, 0, out(result));
		assert.equal(git(f.remote["hson-demo2"], "rev-parse", "main"), commit);
		assertPins(f, [["hson-demo2", commit]]);
	} finally { f.cleanup(); }
});

test("divergent canonical upstream fails without rewriting", () => {
	const f = fixture();
	try {
		sourceCommit(f, "hson-demo2", false);
		const writer = path.join(f.root, "remote-writer");
		git(f.root, "clone", f.remote["hson-demo2"], writer);
		configure(writer);
		appendFileSync(path.join(writer, "source.txt"), "remote update\n");
		git(writer, "add", "source.txt");
		git(writer, "commit", "-m", "Remote update");
		git(writer, "push", "origin", "main");
		const remoteHead = git(f.remote["hson-demo2"], "rev-parse", "main");
		const result = run(f);
		assert.notEqual(result.status, 0);
		assert.match(out(result), /diverged from origin\/main/);
		assert.equal(git(f.remote["hson-demo2"], "rev-parse", "main"), remoteHead);
	} finally { f.cleanup(); }
});

test("module and commit-message arguments are rejected", () => {
	const f = fixture();
	try {
		const result = run(f, ["demo2", "message"]);
		assert.notEqual(result.status, 0);
		assert.match(out(result), /npm run subs:update/);
	} finally { f.cleanup(); }
});
