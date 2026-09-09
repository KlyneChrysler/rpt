import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { activeRun, allocateRunId, listRuns, upsertRun } from "../../src/store/runIndex.js";
import type { RunIndexEntry } from "../../src/store/runIndex.js";

let rptDir = "";

function entry(id: number, overrides: Partial<RunIndexEntry> = {}): RunIndexEntry {
	return {
		id,
		task: `task ${id}`,
		state: "RUNNING",
		startedAt: `2026-09-09T10:0${id}:00.000Z`,
		endedAt: null,
		...overrides,
	};
}

beforeEach(async () => {
	rptDir = await mkdtemp(join(tmpdir(), "rpt-index-"));
});

describe("allocateRunId", () => {
	it("starts at 1", async () => {
		expect(await allocateRunId(rptDir)).toBe(1);
	});

	it("never repeats an id under concurrency", async () => {
		const ids = await Promise.all(Array.from({ length: 20 }, () => allocateRunId(rptDir)));
		expect(new Set(ids).size).toBe(20);
	});
});

describe("listRuns", () => {
	it("returns newest first", async () => {
		await upsertRun(rptDir, entry(1));
		await upsertRun(rptDir, entry(2));
		expect((await listRuns(rptDir)).map((run) => run.id)).toEqual([2, 1]);
	});

	it("collapses an id to its latest write", async () => {
		await upsertRun(rptDir, entry(1));
		await upsertRun(rptDir, entry(1, { state: "ENDED" }));
		const runs = await listRuns(rptDir);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.state).toBe("ENDED");
	});
});

describe("activeRun", () => {
	it("is the newest run that has ended and has not been recorded", async () => {
		await upsertRun(rptDir, entry(1, { state: "RECORDED" }));
		await upsertRun(rptDir, entry(2, { state: "ENDED" }));
		expect((await activeRun(rptDir))?.id).toBe(2);
	});

	it("ignores runs that are still running", async () => {
		await upsertRun(rptDir, entry(1, { state: "RUNNING" }));
		expect(await activeRun(rptDir)).toBeNull();
	});

	it("is null when there are no runs at all", async () => {
		expect(await activeRun(rptDir)).toBeNull();
	});
});
