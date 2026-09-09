import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/domain/events.js";
import type { AgentRun } from "../../src/domain/run.js";
import type { RunIndexEntry } from "../../src/store/runIndex.js";
import { renderRun, renderRunList, renderTimeline } from "../../src/cli/render.js";

const run: AgentRun = {
	id: 1842,
	task: "fix authentication timeout",
	state: "ENDED",
	baseSha: "a".repeat(40),
	endSha: "b".repeat(40),
	startedAt: "2026-09-09T10:00:00.000Z",
	endedAt: "2026-09-09T10:08:41.000Z",
	hasGaps: false,
	claims: { mutatedPaths: ["src/auth/pool.ts"], commands: ["pnpm test"] },
	usage: [{ model: "claude-opus-5", input: 2, output: 410, cacheRead: 100, cacheCreate: 200 }],
};

describe("renderRun", () => {
	it("shows the run id, task and state in text form", () => {
		const output = renderRun(run, "text");
		expect(output).toContain("1842");
		expect(output).toContain("fix authentication timeout");
		expect(output).toContain("ENDED");
	});

	it("shows the duration in minutes and seconds", () => {
		expect(renderRun(run, "text")).toContain("08m 41s");
	});

	it("emits parseable json", () => {
		expect(JSON.parse(renderRun(run, "json")).id).toBe(1842);
	});

	it("keeps the agent format compact", () => {
		expect(renderRun(run, "agent").length).toBeLessThan(400);
	});

	it("warns visibly when the log has gaps", () => {
		expect(renderRun({ ...run, hasGaps: true }, "text")).toMatch(/gap/i);
	});

	it("warns visibly when the log has gaps in agent format too", () => {
		expect(renderRun({ ...run, hasGaps: true }, "agent")).toMatch(/gap/i);
	});

	it("keeps the agent format compact even with hundreds of changed files", () => {
		const bigRun: AgentRun = {
			...run,
			claims: {
				mutatedPaths: Array.from({ length: 300 }, (_, i) => `src/file-${i}.ts`),
				commands: run.claims.commands,
			},
		};
		const output = renderRun(bigRun, "agent");
		expect(output.length).toBeLessThan(400);
		expect(output.split("\n")).toHaveLength(2);
	});
});

describe("renderTimeline", () => {
	it("prints one line per event with a relative offset", () => {
		const events: AgentEvent[] = [
			{ runId: 1, seq: 0, ts: "2026-09-09T10:00:00.000Z", source: "rpt", kind: "RunStarted", payload: {} },
			{ runId: 1, seq: 1, ts: "2026-09-09T10:00:42.000Z", source: "claude-code", kind: "FileMutated", payload: { path: "a.ts" } },
		];
		const lines = renderTimeline(events, "text").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("00:42");
		expect(lines[1]).toContain("a.ts");
	});
});

describe("renderRunList", () => {
	const entries: RunIndexEntry[] = [
		{ id: 2, task: "second run", state: "ENDED", startedAt: "2026-09-09T10:00:00.000Z", endedAt: "2026-09-09T10:05:00.000Z" },
		{ id: 1, task: "first run", state: "RUNNING", startedAt: "2026-09-09T09:00:00.000Z", endedAt: null },
	];

	it("lists runs in text form", () => {
		const output = renderRunList({ entries, corruptLines: 0 }, "text");
		expect(output).toContain("first run");
		expect(output).toContain("second run");
	});

	it("says nothing about corruption when the index is clean", () => {
		expect(renderRunList({ entries, corruptLines: 0 }, "text")).not.toMatch(/corrupt/i);
	});

	it("warns visibly in text output when the index has corrupt lines", () => {
		expect(renderRunList({ entries, corruptLines: 3 }, "text")).toMatch(/3.*corrupt/i);
	});

	it("emits parseable json with the runs and the corrupt line count", () => {
		const parsed = JSON.parse(renderRunList({ entries, corruptLines: 2 }, "json"));
		expect(parsed.corruptLines).toBe(2);
		expect(parsed.runs).toHaveLength(2);
		expect(parsed.runs[0].id).toBe(2);
	});
});
