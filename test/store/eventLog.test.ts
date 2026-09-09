import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { DraftEvent } from "../../src/domain/events.js";
import { appendEvent, readEvents } from "../../src/store/eventLog.js";
import { runDirOf } from "../../src/store/paths.js";

let rptDir = "";

function draft(kind: DraftEvent["kind"], payload: Record<string, unknown> = {}): DraftEvent {
	return { ts: "2026-09-09T10:00:00.000Z", source: "claude-code", kind, payload };
}

beforeEach(async () => {
	rptDir = await mkdtemp(join(tmpdir(), "rpt-log-"));
});

describe("appendEvent", () => {
	it("assigns sequence numbers starting at zero", async () => {
		const first = await appendEvent(rptDir, 1, draft("RunStarted", { task: "t" }));
		const second = await appendEvent(rptDir, 1, draft("FileMutated", { path: "a.ts" }));
		expect([first.seq, second.seq]).toEqual([0, 1]);
	});

	it("keeps sequence numbers independent per run", async () => {
		await appendEvent(rptDir, 1, draft("RunStarted"));
		const other = await appendEvent(rptDir, 2, draft("RunStarted"));
		expect(other.seq).toBe(0);
	});

	it("survives concurrent appends without losing or repeating a sequence", async () => {
		await Promise.all(
			Array.from({ length: 25 }, () => appendEvent(rptDir, 1, draft("FileMutated", { path: "a.ts" }))),
		);
		const { events } = await readEvents(rptDir, 1);
		expect(events.map((event) => event.seq)).toEqual([...Array(25).keys()]);
	});

	it("truncates an oversized payload and marks it", async () => {
		const event = await appendEvent(rptDir, 1, draft("CommandCompleted", { stdout: "x".repeat(20000) }));
		expect(event.payload.truncated).toBe(true);
		expect(JSON.stringify(event).length).toBeLessThan(9000);
	});
});

describe("readEvents", () => {
	it("round trips what was appended", async () => {
		await appendEvent(rptDir, 1, draft("RunStarted", { task: "fix auth" }));
		const { events, gapCount } = await readEvents(rptDir, 1);
		expect(gapCount).toBe(0);
		expect(events[0]?.payload.task).toBe("fix auth");
	});

	it("returns an empty result for a run that has no log", async () => {
		expect(await readEvents(rptDir, 99)).toEqual({ events: [], gapCount: 0 });
	});

	it("skips a torn trailing line and counts it as a gap", async () => {
		await appendEvent(rptDir, 1, draft("RunStarted", { task: "t" }));
		await appendFile(join(runDirOf(rptDir, 1), "events.jsonl"), '{"runId":1,"seq":1,"kind":"Fi');
		const { events, gapCount } = await readEvents(rptDir, 1);
		expect(events).toHaveLength(1);
		expect(gapCount).toBe(1);
	});

	it("rejects a line whose checksum no longer matches its payload", async () => {
		await appendEvent(rptDir, 1, draft("RunStarted", { task: "t" }));
		const path = join(runDirOf(rptDir, 1), "events.jsonl");
		const tampered = (await readFile(path, "utf8")).replace('"task":"t"', '"task":"evil"');
		await writeFile(path, tampered);
		const { events, gapCount } = await readEvents(rptDir, 1);
		expect(events).toHaveLength(0);
		expect(gapCount).toBe(1);
	});
});
