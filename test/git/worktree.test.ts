import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "../../src/git/exec.js";
import { createSnapshot } from "../../src/git/snapshot.js";
import { openWorktree, pruneWorktrees } from "../../src/git/worktree.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

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
});

describe("pruneWorktrees", () => {
	it("reports nothing to clean in a fresh repo", async () => {
		expect(await pruneWorktrees(await makeFixtureRepo())).toEqual([]);
	});
});
