import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { endRun, NoRunInProgressError } from "../../src/app/endRun.js";
import { loadRun } from "../../src/app/loadRun.js";
import { recordEvent } from "../../src/app/recordEvent.js";
import { startRun } from "../../src/app/startRun.js";
import { readEvents } from "../../src/store/eventLog.js";
import { activeRun, listRuns, readIndex } from "../../src/store/runIndex.js";
import { rptDirOf } from "../../src/store/paths.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

describe("run lifecycle", () => {
	it("starts a run, records the base sha and leaves it RUNNING", async () => {
		const repo = await makeFixtureRepo();
		const run = await startRun(repo, { task: "fix auth", transcriptPath: null });
		expect(run.id).toBe(1);
		expect(run.state).toBe("RUNNING");
		expect(run.baseSha).toMatch(/^[0-9a-f]{40}$/);
	});

	it("records agent claims into the log", async () => {
		const repo = await makeFixtureRepo();
		await startRun(repo, { task: "t", transcriptPath: null });
		await recordEvent(repo, {
			ts: "2026-09-09T10:01:00.000Z",
			source: "claude-code",
			kind: "FileMutated",
			payload: { path: "a.ts" },
		});
		const run = await loadRun(repo, 1);
		expect(run.claims.mutatedPaths).toEqual(["a.ts"]);
	});

	it("ends a run, snapshots uncommitted work and becomes the active run", async () => {
		const repo = await makeFixtureRepo();
		await startRun(repo, { task: "t", transcriptPath: null });
		await writeFile(join(repo, "new.ts"), "export const a = 1;\n");
		const ended = await endRun(repo);
		expect(ended.state).toBe("ENDED");
		expect(ended.endSha).toMatch(/^[0-9a-f]{40}$/);
		expect((await activeRun(rptDirOf(repo)))?.id).toBe(1);
	});

	it("ends a run started with a transcript path carrying a non-empty usage array", async () => {
		const repo = await makeFixtureRepo();
		await startRun(repo, { task: "t", transcriptPath: "test/fixtures/transcript.jsonl" });
		const ended = await endRun(repo);
		expect(ended.usage.length).toBeGreaterThan(0);
	});

	it("refuses to end a run when none is running", async () => {
		const repo = await makeFixtureRepo();
		await expect(endRun(repo)).rejects.toThrow(/no run in progress/i);
	});

	it("numbers a second run independently", async () => {
		const repo = await makeFixtureRepo();
		await startRun(repo, { task: "one", transcriptPath: null });
		await endRun(repo);
		const second = await startRun(repo, { task: "two", transcriptPath: null });
		expect(second.id).toBe(2);
	});

	// Controller ruling: real SessionStart payloads carry no task, so startRun is
	// given "" rather than a placeholder. The index row written at start time is
	// therefore blank; once the first prompt lands, endRun must reload through the
	// fold before writing the final row so the row self-heals to the derived task.
	it("self-heals the index row's task from the first prompt once the run ends", async () => {
		const repo = await makeFixtureRepo();
		const started = await startRun(repo, { task: "", transcriptPath: null });
		expect(started.task).toBe("");

		await recordEvent(repo, {
			ts: "2026-09-09T10:01:00.000Z",
			source: "claude-code",
			kind: "PromptSubmitted",
			payload: { prompt: "fix the auth bug\nmore detail" },
		});
		await endRun(repo);

		const rows = await listRuns(rptDirOf(repo));
		const row = rows.find((entry) => entry.id === 1);
		expect(row?.task).toBe("fix the auth bug");
		expect(row?.task).not.toBe("");
		expect(row?.task).not.toBe("agent session");
	});

	// Review finding: two concurrent hook processes must not both read the pointer
	// as non-null and both proceed to seal the same run - that would append two
	// AgentStopped events and two ENDED index rows. This fires the race with
	// Promise.all rather than sequentially, so it actually exercises the lock.
	it("seals a run exactly once when two endRun calls race for it", async () => {
		const repo = await makeFixtureRepo();
		await startRun(repo, { task: "t", transcriptPath: null });

		const results = await Promise.allSettled([endRun(repo), endRun(repo)]);
		const fulfilled = results.filter((result) => result.status === "fulfilled");
		const rejected = results.filter((result) => result.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(NoRunInProgressError);

		const { events } = await readEvents(rptDirOf(repo), 1);
		expect(events.filter((event) => event.kind === "AgentStopped")).toHaveLength(1);

		const { entries } = await readIndex(join(rptDirOf(repo), "index.jsonl"));
		expect(entries.filter((entry) => entry.id === 1 && entry.state === "ENDED")).toHaveLength(1);
	});
});
