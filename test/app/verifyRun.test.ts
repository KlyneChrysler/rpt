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

	it("is idempotent: a second call returns the recorded verdict, and the log stays readable", async () => {
		const repo = await repoWithRun({ "a.ts": "1\n" }, ["a.ts"]);
		const first = await verifyRun(repo, 1);
		const second = await verifyRun(repo, 1);
		expect(second).toEqual(first);
		// The bug this guards against didn't fail here - it failed on read: a naive
		// re-entry appends a second VerificationStarted event, which is an illegal
		// VERIFYING -> VERIFYING transition that throws on every future projection
		// of this run's log, not at the point of the mistake.
		await expect(loadRun(repo, 1)).resolves.toMatchObject({ state: "VERIFYING" });
	});

	it("refuses to re-verify a run interrupted before any verdict was written", async () => {
		const repo = await repoWithRun({ "a.ts": "1\n" }, ["a.ts"]);
		const { appendEvent } = await import("../../src/store/eventLog.js");
		const { rptDirOf } = await import("../../src/store/paths.js");
		// Simulates a crash between appending VerificationStarted and writing a
		// verdict: the run is stuck in VERIFYING with nothing on disk to recover.
		await appendEvent(rptDirOf(repo), 1, { ts: new Date().toISOString(), source: "rpt", kind: "VerificationStarted", payload: {} });
		await expect(verifyRun(repo, 1)).rejects.toThrow(/interrupted/);
	});

	it("propagates the real failure rather than a worktree disposal failure, and still disposes the worktree", async () => {
		const repo = await repoWithRun({ "a.ts": "1\n" }, ["a.ts"]);
		// Corrupts config *after* the run ended, so verifyRun's own read of it
		// (inside the try block, after the worktree is already open) is what fails
		// - not something earlier that would never reach the disposal guard at all.
		await writeFile(join(repo, "rpt.config.json"), "{ not json");
		await expect(verifyRun(repo, 1)).rejects.toThrow(/rpt\.config\.json is unreadable/);
		const { git } = await import("../../src/git/exec.js");
		expect(await git(repo, ["worktree", "list"])).not.toContain("rpt-wt-");
	});
});
