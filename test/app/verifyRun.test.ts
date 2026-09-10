import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initRepo } from "../../src/app/initRepo.js";
import { loadRun } from "../../src/app/loadRun.js";
import { readVerdict, verifyRun } from "../../src/app/verifyRun.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

async function repoWithRun(files: Record<string, string>, claimed: string[]): Promise<string> {
	const repo = await makeFixtureRepo();
	await initRepo(repo);
	await writeFile(join(repo, "rpt.config.json"), JSON.stringify({ testCommand: "exit 0" }));
	await driveFakeAgent(repo, [
		{ kind: "start", transcriptPath: null },
		...claimed.map((path) => ({ kind: "edit" as const, path, body: files[path] ?? "" })),
		{ kind: "stop" },
	]);
	return repo;
}

describe("verifyRun", () => {
	it("returns UNVERIFIED when a verifier had to skip", async () => {
		const repo = await repoWithRun({ "a.ts": "1\n" }, ["a.ts"]);
		const verdict = await verifyRun(repo, 1);
		expect(verdict.name).toBe("UNVERIFIED");
		expect(verdict.results.find((result) => result.id === "test-quality")?.status).toBe("skipped");
	});

	it("records the verdict so it can be read back", async () => {
		const repo = await repoWithRun({ "a.ts": "1\n" }, ["a.ts"]);
		await verifyRun(repo, 1);
		expect((await readVerdict(repo, 1))?.name).toBe("UNVERIFIED");
	});

	it("moves the run out of ENDED", async () => {
		const repo = await repoWithRun({ "a.ts": "1\n" }, ["a.ts"]);
		await verifyRun(repo, 1);
		expect((await loadRun(repo, 1)).state).not.toBe("ENDED");
	});

	it("fails the run when an undeclared file is present", async () => {
		const repo = await repoWithRun({ "a.ts": "1\n" }, ["a.ts"]);
		await writeFile(join(repo, "sneaky.ts"), "1\n");
		const { endRun } = await import("../../src/app/endRun.js");
		await expect(endRun(repo)).rejects.toThrow();
		expect((await verifyRun(repo, 1)).name).toBe("UNVERIFIED");
	});

	it("leaves no worktree behind", async () => {
		const repo = await repoWithRun({ "a.ts": "1\n" }, ["a.ts"]);
		await verifyRun(repo, 1);
		const { git } = await import("../../src/git/exec.js");
		expect(await git(repo, ["worktree", "list"])).not.toContain("rpt-wt-");
	});
});
