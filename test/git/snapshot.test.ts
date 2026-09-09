import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "../../src/git/exec.js";
import { createSnapshot, headSha } from "../../src/git/snapshot.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

describe("createSnapshot", () => {
	it("captures uncommitted work as a commit object", async () => {
		const repo = await makeFixtureRepo();
		await writeFile(join(repo, "new.ts"), "export const a = 1;\n");
		const sha = await createSnapshot(repo, 1, "end");
		const listed = await git(repo, ["ls-tree", "--name-only", sha]);
		expect(listed.split("\n")).toContain("new.ts");
	});

	it("leaves the user's index untouched", async () => {
		const repo = await makeFixtureRepo();
		await writeFile(join(repo, "new.ts"), "export const a = 1;\n");
		await createSnapshot(repo, 1, "end");
		const staged = await git(repo, ["diff", "--cached", "--name-only"]);
		expect(staged).toBe("");
	});

	it("leaves the working tree untouched", async () => {
		const repo = await makeFixtureRepo();
		await writeFile(join(repo, "new.ts"), "export const a = 1;\n");
		await createSnapshot(repo, 1, "end");
		const status = await git(repo, ["status", "--porcelain"]);
		expect(status).toContain("new.ts");
	});

	it("stores the snapshot under a run-scoped ref", async () => {
		const repo = await makeFixtureRepo();
		const sha = await createSnapshot(repo, 7, "base");
		expect(await git(repo, ["rev-parse", "refs/rpt/runs/7/base"])).toBe(sha);
	});
});

describe("headSha", () => {
	it("returns the current commit", async () => {
		const repo = await makeFixtureRepo();
		expect(await headSha(repo)).toMatch(/^[0-9a-f]{40}$/);
	});

	it("returns null in a repo with no commits", async () => {
		const repo = await mkdtemp(join(tmpdir(), "rpt-empty-"));
		await git(repo, ["init", "-q", "-b", "main"]);
		await git(repo, ["config", "user.email", "test@example.com"]);
		await git(repo, ["config", "user.name", "rpt test"]);
		expect(await headSha(repo)).toBeNull();
	});
});
