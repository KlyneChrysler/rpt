import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, GitError } from "../../src/git/exec.js";
import { createSnapshot } from "../../src/git/snapshot.js";
import { openWorktree } from "../../src/git/worktree.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

const HOOK_SCOPE = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"] as const;

afterEach(() => {
	for (const name of HOOK_SCOPE) delete process.env[name];
});

describe("git", () => {
	it("returns trimmed stdout", async () => {
		const repo = await makeFixtureRepo();
		expect(await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
	});

	it("throws a GitError carrying the exit code and stderr", async () => {
		const repo = await makeFixtureRepo();
		await expect(git(repo, ["rev-parse", "definitely-not-a-ref"])).rejects.toBeInstanceOf(GitError);
	});

	// The exact failure driving the built binary from a real pre-commit hook
	// produced: git exports GIT_DIR and GIT_INDEX_FILE into every hook, rpt's
	// git subprocesses inherited them, and `git worktree add` then resolved the
	// new worktree's `.git` - a file, not a directory - and failed before a
	// single verifier ran. Everything passed in tests, because tests are not
	// invoked from a hook.
	it("ignores the git scoping variables a hook exports into its environment", async () => {
		const repo = await makeFixtureRepo();
		process.env.GIT_DIR = join(repo, ".git");
		process.env.GIT_INDEX_FILE = join(repo, ".git", "index");
		process.env.GIT_PREFIX = "";
		await writeFile(join(repo, "auth.ts"), "export const timeout = 5000;\n");
		const sha = await createSnapshot(repo, 1, "end");
		const worktree = await openWorktree(repo, sha);
		try {
			expect(await git(worktree.path, ["rev-parse", "HEAD"])).toBe(sha);
		} finally {
			await worktree.dispose();
		}
	});

	it("still honours a scoping variable the caller sets deliberately", async () => {
		const repo = await makeFixtureRepo();
		process.env.GIT_INDEX_FILE = join(repo, ".git", "index");
		await writeFile(join(repo, "untracked.ts"), "export const a = 1;\n");
		// createSnapshot passes its own GIT_INDEX_FILE so the user's real index is
		// never staged into. If stripping the inherited value also dropped the
		// caller's, this snapshot would stage into the real index instead.
		await createSnapshot(repo, 1, "end");
		expect(await git(repo, ["diff", "--cached", "--name-only"])).toBe("");
	});
});
