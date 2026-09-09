import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "../../src/git/exec.js";
import { createSnapshot } from "../../src/git/snapshot.js";
import { openWorktree, pruneWorktrees } from "../../src/git/worktree.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

async function rptTempDirs(): Promise<string[]> {
	return (await readdir(tmpdir())).filter((name) => name.startsWith("rpt-wt-"));
}

describe("openWorktree", () => {
	it("materialises the snapshot's file contents", async () => {
		const repo = await makeFixtureRepo();
		await writeFile(join(repo, "auth.ts"), "export const timeout = 5000;\n");
		const sha = await createSnapshot(repo, 1, "end");
		const worktree = await openWorktree(repo, sha);
		expect(await readFile(join(worktree.path, "auth.ts"), "utf8")).toContain("5000");
		await worktree.dispose();
	});

	it("is isolated from later edits in the original repo", async () => {
		const repo = await makeFixtureRepo();
		await writeFile(join(repo, "auth.ts"), "first\n");
		const worktree = await openWorktree(repo, await createSnapshot(repo, 1, "end"));
		await writeFile(join(repo, "auth.ts"), "second\n");
		expect(await readFile(join(worktree.path, "auth.ts"), "utf8")).toBe("first\n");
		await worktree.dispose();
	});

	it("removes itself on dispose", async () => {
		const repo = await makeFixtureRepo();
		const worktree = await openWorktree(repo, await createSnapshot(repo, 1, "end"));
		await worktree.dispose();
		expect(await git(repo, ["worktree", "list"])).not.toContain(worktree.path);
	});

	it("leaves the original checkout on its own branch", async () => {
		const repo = await makeFixtureRepo();
		const worktree = await openWorktree(repo, await createSnapshot(repo, 1, "end"));
		expect(await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
		await worktree.dispose();
	});

	// The temp parent directory is created before `git worktree add` runs, so a
	// rejected add must not leave it behind - no handle is ever returned for
	// anyone to dispose it.
	it("leaves no temp directory behind when the add fails", async () => {
		const repo = await makeFixtureRepo();
		const before = await rptTempDirs();
		await expect(openWorktree(repo, "0000000000000000000000000000000000dead")).rejects.toThrow();
		expect(await rptTempDirs()).toEqual(before);
	});

	// A failed `worktree remove` (most commonly a locked worktree) must not leave
	// an unrecoverable leak: `git worktree prune` only clears registrations whose
	// directory is already gone, and never touches a locked one at all. Locking
	// the worktree first forces `remove` to fail deterministically through real
	// git rather than a mock.
	it("clears both the directory and the registration after a failed removal", async () => {
		const repo = await makeFixtureRepo();
		const before = await rptTempDirs();
		const worktree = await openWorktree(repo, await createSnapshot(repo, 1, "end"));
		await git(repo, ["worktree", "lock", worktree.path]);
		await worktree.dispose();
		expect(await rptTempDirs()).toEqual(before);
		expect(await git(repo, ["worktree", "list"])).not.toContain(worktree.path);
	});
});

describe("pruneWorktrees", () => {
	it("reports nothing to clean in a fresh repo", async () => {
		expect(await pruneWorktrees(await makeFixtureRepo())).toEqual([]);
	});

	it("detects and reports a worktree whose directory was removed without telling git", async () => {
		const repo = await makeFixtureRepo();
		const worktree = await openWorktree(repo, await createSnapshot(repo, 1, "end"));
		await rm(worktree.path, { recursive: true, force: true });
		const pruned = await pruneWorktrees(repo);
		// git resolves the registered path (e.g. through macOS's /var -> /private/var
		// symlink), so it need not match our literal temp path byte-for-byte -
		// compare on the "rpt-wt-*/tree" tail both sides agree on instead.
		const tail = join(basename(dirname(worktree.path)), basename(worktree.path));
		expect(pruned).toEqual([expect.stringContaining(tail)]);
		expect(await git(repo, ["worktree", "list"])).not.toContain(worktree.path);
	});
});
