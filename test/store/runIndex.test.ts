import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activeRun, allocateRunId, latestEntries, listRuns, openRun, readIndex, upsertRun } from "../../src/store/runIndex.js";
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

	// Allocating on top of a hole is how one bad line becomes permanent: the highest
	// id can no longer be known, so the next run either collides with a run already
	// on disk or is numbered from a value that was never read. Refusing is loud and
	// recoverable; allocating is silent and is not.
	it("refuses to allocate while the index has corrupt lines", async () => {
		await upsertRun(rptDir, entry(1));
		await appendFile(join(rptDir, "index.jsonl"), "42\n");
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			await expect(allocateRunId(rptDir)).rejects.toThrow(/corrupt/i);
		} finally {
			spy.mockRestore();
		}
	});

	it("allocates an integer id, never a NaN, once the index is clean again", async () => {
		await upsertRun(rptDir, entry(1));
		expect(Number.isInteger(await allocateRunId(rptDir))).toBe(true);
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

describe("latestEntries", () => {
	it("collapses repeated rows for the same id to the last one, newest id first", () => {
		const rows = [entry(1), entry(2), entry(1, { state: "ENDED" }), entry(2, { state: "RECORDED" })];
		expect(latestEntries(rows)).toEqual([entry(2, { state: "RECORDED" }), entry(1, { state: "ENDED" })]);
	});

	it("is what listRuns uses internally, so the two never drift", async () => {
		await upsertRun(rptDir, entry(1));
		await upsertRun(rptDir, entry(1, { state: "ENDED" }));
		const { entries } = await readIndex(rptDir);
		expect(await listRuns(rptDir)).toEqual(latestEntries(entries));
	});

	it("returns an empty array for an empty index", () => {
		expect(latestEntries([])).toEqual([]);
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

	it("still names a rejected run, so the gate keeps refusing its commit", async () => {
		await upsertRun(rptDir, entry(1, { state: "REJECTED" }));
		expect((await activeRun(rptDir))?.id).toBe(1);
	});
});

// activeRun answers the gate's question - is there a run awaiting adjudication -
// and must keep excluding RUNNING for that meaning to stay precise. openRun answers
// the user's question: is a run happening right now. Two questions, two functions;
// widening one to serve the other is what made the listing and status contradict
// each other while a run was live.
describe("openRun", () => {
	it("is the run that is still running", async () => {
		await upsertRun(rptDir, entry(1, { state: "RUNNING" }));
		expect((await openRun(rptDir))?.id).toBe(1);
	});

	it("is the newest run that has not reached a terminal state", async () => {
		await upsertRun(rptDir, entry(1, { state: "ENDED" }));
		await upsertRun(rptDir, entry(2, { state: "RECORDED" }));
		expect((await openRun(rptDir))?.id).toBe(1);
	});

	it("is null when every run has been recorded", async () => {
		await upsertRun(rptDir, entry(1, { state: "RECORDED" }));
		expect(await openRun(rptDir)).toBeNull();
	});

	it("is null when there are no runs at all", async () => {
		expect(await openRun(rptDir)).toBeNull();
	});

	it("does not change what activeRun means", async () => {
		await upsertRun(rptDir, entry(1, { state: "RUNNING" }));
		expect(await activeRun(rptDir)).toBeNull();
		expect(await openRun(rptDir)).not.toBeNull();
	});
});

describe("readIndex", () => {
	it("returns the valid entries and reports one corrupt line", async () => {
		await upsertRun(rptDir, entry(1));
		await appendFile(join(rptDir, "index.jsonl"), "not json\n");
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const { entries, corruptLines } = await readIndex(rptDir);
		spy.mockRestore();
		expect(entries.map((e) => e.id)).toEqual([1]);
		expect(corruptLines).toBe(1);
	});

	// Valid JSON that is not a well-formed entry is the dangerous case: it used to
	// pass the parse and count as a good row, so the corrupt-line count stayed zero
	// and every reader downstream trusted a row with no id, no state and no task.
	it("counts a bare number as corrupt rather than as an entry", async () => {
		await upsertRun(rptDir, entry(1));
		await appendFile(join(rptDir, "index.jsonl"), "42\n");
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const { entries, corruptLines } = await readIndex(rptDir);
		spy.mockRestore();
		expect(entries.map((e) => e.id)).toEqual([1]);
		expect(corruptLines).toBe(1);
	});

	it("counts a row whose id is not an integer as corrupt", async () => {
		await appendFile(
			join(rptDir, "index.jsonl"),
			`${JSON.stringify({ ...entry(1), id: "1" })}\n${JSON.stringify({ ...entry(2), id: 1.5 })}\n`,
		);
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const { entries, corruptLines } = await readIndex(rptDir);
		spy.mockRestore();
		expect(entries).toEqual([]);
		expect(corruptLines).toBe(2);
	});

	it("counts a row carrying an unknown state as corrupt", async () => {
		await appendFile(join(rptDir, "index.jsonl"), `${JSON.stringify({ ...entry(1), state: "WAT" })}\n`);
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const { entries, corruptLines } = await readIndex(rptDir);
		spy.mockRestore();
		expect(entries).toEqual([]);
		expect(corruptLines).toBe(1);
	});

	it("counts a row missing a required field as corrupt", async () => {
		await appendFile(join(rptDir, "index.jsonl"), `${JSON.stringify({ id: 1, task: "t" })}\n`);
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const { corruptLines } = await readIndex(rptDir);
		spy.mockRestore();
		expect(corruptLines).toBe(1);
	});

	it("reports zero corrupt lines for a wholly valid index", async () => {
		await upsertRun(rptDir, entry(1));
		await upsertRun(rptDir, entry(2));
		const { corruptLines } = await readIndex(rptDir);
		expect(corruptLines).toBe(0);
	});

	it("does not throw when it warns about corrupted lines", async () => {
		await upsertRun(rptDir, entry(1));
		await appendFile(join(rptDir, "index.jsonl"), "not json\nalso not json\n");
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await expect(readIndex(rptDir)).resolves.toMatchObject({ corruptLines: 2 });
		spy.mockRestore();
	});
});

describe("torn fragment recovery", () => {
	it("does not swallow the next valid write when it lands right after a torn fragment", async () => {
		await upsertRun(rptDir, entry(1));
		await appendFile(join(rptDir, "index.jsonl"), '{"id":2,"task":"broken"');
		await upsertRun(rptDir, entry(2));
		const { entries, corruptLines } = await readIndex(rptDir);
		expect(entries.map((e) => e.id).sort()).toEqual([1, 2]);
		expect(corruptLines).toBe(1);
	});
});
