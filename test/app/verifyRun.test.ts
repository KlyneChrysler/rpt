import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { initRepo } from "../../src/app/initRepo.js";
import { loadRun } from "../../src/app/loadRun.js";
import { disposeQuietly, readVerdict, verifyRun } from "../../src/app/verifyRun.js";
import { rptDirOf } from "../../src/store/paths.js";
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

	it("gives the true reason for a run that was never sealed, not a fabricated interruption", async () => {
		// No "stop" step: the run is started but never ends, so it never becomes a
		// candidate for verification at all - this must not be reported as an
		// interrupted verification attempt, which would invent a history that
		// never happened.
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		await writeFile(join(repo, "rpt.config.json"), JSON.stringify({ testCommand: "exit 0" }));
		await driveFakeAgent(repo, [{ kind: "start", transcriptPath: null }]);
		await expect(verifyRun(repo, 1)).rejects.toThrow(/no sealed end state/);
	});

	it("catches the index up to a verdict that was written just before a crash", async () => {
		const repo = await repoWithRun({ "a.ts": "1\n" }, ["a.ts"]);
		const { appendEvent } = await import("../../src/store/eventLog.js");
		const { rptDirOf } = await import("../../src/store/paths.js");
		const { listRuns } = await import("../../src/store/runIndex.js");
		const { writeVerdict } = await import("../../src/store/verdicts.js");
		const rptDir = rptDirOf(repo);

		// Simulates a crash between writeVerdict and the final upsertRun in the
		// previous (successful) attempt: the verdict is durably on disk, but the
		// index still shows whatever it was left at (ENDED, in this fixture).
		await appendEvent(rptDir, 1, { ts: new Date().toISOString(), source: "rpt", kind: "VerificationStarted", payload: {} });
		const staged = { runId: 1, name: "UNVERIFIED" as const, results: [], decidedAt: new Date().toISOString() };
		await writeVerdict(rptDir, staged);

		expect(await verifyRun(repo, 1)).toEqual(staged);

		const after = (await listRuns(rptDir)).find((entry) => entry.id === 1);
		expect(after?.state).toBe("UNVERIFIED");
	});

	it("does not drag an index that has moved past the verdict stage backwards", async () => {
		const repo = await repoWithRun({ "a.ts": "1\n" }, ["a.ts"]);
		await verifyRun(repo, 1);
		const { rptDirOf } = await import("../../src/store/paths.js");
		const { listRuns, upsertRun } = await import("../../src/store/runIndex.js");
		const rptDir = rptDirOf(repo);
		// Simulates a later plan's approval step having already moved this closed
		// run further along than verifyRun itself ever writes.
		const indexed = (await listRuns(rptDir)).find((entry) => entry.id === 1);
		if (indexed === undefined) throw new Error("test setup: run 1 missing from the index");
		await upsertRun(rptDir, { ...indexed, state: "AWAITING_APPROVAL" });

		await verifyRun(repo, 1);

		const after = (await listRuns(rptDir)).find((entry) => entry.id === 1);
		expect(after?.state).toBe("AWAITING_APPROVAL");
	});

	it("propagates the real failure rather than a worktree disposal failure, and still disposes the worktree", async () => {
		const repo = await repoWithRun({ "a.ts": "1\n" }, ["a.ts"]);
		// Forces a real failure *inside* the try block, after the worktree is
		// already open, by making the VerifierCompleted append (not the
		// VerificationStarted one that precedes openWorktree) fail. A corrupt
		// config snapshot used to serve this purpose, but resolveRunConfig no
		// longer ever throws for one (see src/app/loadRunConfig.ts - a corrupt
		// or missing snapshot is handled as forced drift, not a permanent
		// refusal), so this test needs its own, independent way to trigger a
		// failure at the same point in the control flow.
		const eventLogModule = await import("../../src/store/eventLog.js");
		const realAppendEvent = eventLogModule.appendEvent;
		const spy = vi.spyOn(eventLogModule, "appendEvent").mockImplementation(async (rptDir, id, draft) => {
			if (draft.kind === "VerifierCompleted") throw new Error("simulated append failure after the worktree opened");
			return realAppendEvent(rptDir, id, draft);
		});
		try {
			await expect(verifyRun(repo, 1)).rejects.toThrow(/simulated append failure/);
		} finally {
			spy.mockRestore();
		}
		const { git } = await import("../../src/git/exec.js");
		expect(await git(repo, ["worktree", "list"])).not.toContain("rpt-wt-");
	});
});

describe("disposeQuietly", () => {
	it("logs the disposal failure to stderr without throwing, naming both errors", async () => {
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const fakeWorktree = {
				path: "/fake/rpt-wt-test/tree",
				dispose: () => Promise.reject(new Error("dispose boom")),
			};
			await expect(disposeQuietly(fakeWorktree, 1, new Error("pending failure"))).resolves.toBeUndefined();
			expect(spy).toHaveBeenCalledTimes(1);
			const [message] = spy.mock.calls[0] as [string];
			expect(message).toContain("pending failure");
			expect(message).toContain("dispose boom");
		} finally {
			spy.mockRestore();
		}
	});

	it("resolves silently when disposal succeeds", async () => {
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const fakeWorktree = { path: "/fake/rpt-wt-test/tree", dispose: () => Promise.resolve() };
			await expect(disposeQuietly(fakeWorktree, 1, new Error("pending failure"))).resolves.toBeUndefined();
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});
