import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findGitRoot, findRepoRoot } from "../../src/store/paths.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

describe("findGitRoot", () => {
	it("finds the root from a nested subdirectory", async () => {
		const repo = await makeFixtureRepo();
		const nested = join(repo, "src/deep/deeper");
		await mkdir(nested, { recursive: true });
		expect(await findGitRoot(nested)).toBe(repo);
	});

	it("is null outside any git repository", async () => {
		expect(await findGitRoot(await mkdtemp(join(tmpdir(), "rpt-bare-")))).toBeNull();
	});
});

describe("findRepoRoot", () => {
	it("finds the git root from a nested subdirectory", async () => {
		const repo = await makeFixtureRepo();
		const nested = join(repo, "a/b");
		await mkdir(nested, { recursive: true });
		expect(await findRepoRoot(nested)).toBe(repo);
	});

	// A recorded directory need not be a git repository at all - it is the .rpt
	// directory, not .git, that says rpt has anything to report here.
	it("finds a directory that only has an rpt directory", async () => {
		const base = await mkdtemp(join(tmpdir(), "rpt-only-"));
		await mkdir(join(base, ".rpt/runs"), { recursive: true });
		await mkdir(join(base, "sub"), { recursive: true });
		expect(await findRepoRoot(join(base, "sub"))).toBe(base);
	});

	it("finds a git worktree whose .git is a file rather than a directory", async () => {
		const base = await mkdtemp(join(tmpdir(), "rpt-worktree-"));
		await writeFile(join(base, ".git"), "gitdir: /somewhere/else\n");
		await mkdir(join(base, "sub"), { recursive: true });
		expect(await findRepoRoot(join(base, "sub"))).toBe(base);
	});

	it("is null when neither marker is anywhere above", async () => {
		expect(await findRepoRoot(await mkdtemp(join(tmpdir(), "rpt-bare-")))).toBeNull();
	});
});
