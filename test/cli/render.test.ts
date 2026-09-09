import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/domain/events.js";
import type { AgentRun } from "../../src/domain/run.js";
import type { RunIndexEntry } from "../../src/store/runIndex.js";
import { renderActiveRun, renderRun, renderRunList, renderTimeline } from "../../src/cli/render.js";

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

describe("renderActiveRun", () => {
	it("renders the run itself when one is active", () => {
		expect(renderActiveRun(run, "text")).toContain("1842");
	});

	it("says there is no active run in text form", () => {
		expect(renderActiveRun(null, "text")).toBe("no active run");
	});

	it("says there is no active run in agent form", () => {
		expect(renderActiveRun(null, "agent")).toBe("no active run");
	});

	it("emits parseable json when there is no active run", () => {
		const parsed = JSON.parse(renderActiveRun(null, "json"));
		expect(parsed.active).toBeNull();
	});

	it("emits parseable json when a run is active", () => {
		expect(JSON.parse(renderActiveRun(run, "json")).id).toBe(1842);
	});

	// A run that has an id but no first event yet is a normal, transient state that
	// every session passes through, so it renders as a state rather than raising.
	it("names a run that is still starting in text form", () => {
		const output = renderActiveRun({ pending: "starting", id: 9 }, "text");
		expect(output).toMatch(/starting/i);
		expect(output).toContain("9");
		expect(output).not.toMatch(/no active run/i);
	});

	it("names a run that is still starting in agent form", () => {
		expect(renderActiveRun({ pending: "starting", id: 9 }, "agent")).toMatch(/starting/i);
	});

	it("emits parseable json for a run that is still starting", () => {
		const parsed = JSON.parse(renderActiveRun({ pending: "starting", id: 9 }, "json"));
		expect(parsed.active).toEqual({ id: 9, pending: "starting" });
	});
});

describe("renderTimeline", () => {
	const events: AgentEvent[] = [
		{ runId: 1, seq: 0, ts: "2026-09-09T10:00:00.000Z", source: "rpt", kind: "RunStarted", payload: {} },
		{ runId: 1, seq: 1, ts: "2026-09-09T10:00:42.000Z", source: "claude-code", kind: "FileMutated", payload: { path: "a.ts" } },
	];

	it("prints one line per event with a relative offset", () => {
		const lines = renderTimeline(events, 0, "text").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("00:42");
		expect(lines[1]).toContain("a.ts");
	});

	it("emits parseable json with one entry per event", () => {
		const parsed = JSON.parse(renderTimeline(events, 0, "json"));
		expect(parsed.events).toHaveLength(2);
		expect(parsed.events[1].kind).toBe("FileMutated");
	});

	// The run summary already warns about a gapped run. A timeline that stays silent
	// about the same log is the surface a user reaches for to find out what is
	// missing, so it is the last place that should look clean.
	it("warns visibly when the run's log has unreadable lines", () => {
		expect(renderTimeline(events, 2, "text")).toMatch(/2.*gap/i);
	});

	it("says nothing about gaps for a clean log", () => {
		expect(renderTimeline(events, 0, "text")).not.toMatch(/gap/i);
	});

	it("carries the gap count in json alongside the events", () => {
		const parsed = JSON.parse(renderTimeline(events, 3, "json"));
		expect(parsed.gapCount).toBe(3);
	});
});

describe("renderRunList", () => {
	const entries: RunIndexEntry[] = [
		{ id: 2, task: "second run", state: "ENDED", startedAt: "2026-09-09T10:00:00.000Z", endedAt: "2026-09-09T10:05:00.000Z" },
		{ id: 1, task: "first run", state: "RUNNING", startedAt: "2026-09-09T09:00:00.000Z", endedAt: null },
	];

	it("lists runs in text form", () => {
		const output = renderRunList({ entries, corruptLines: 0, startFailures: [] }, "text");
		expect(output).toContain("first run");
		expect(output).toContain("second run");
	});

	it("says nothing about corruption when the index is clean", () => {
		expect(renderRunList({ entries, corruptLines: 0, startFailures: [] }, "text")).not.toMatch(/corrupt/i);
	});

	it("warns visibly in text output when the index has corrupt lines", () => {
		expect(renderRunList({ entries, corruptLines: 3, startFailures: [] }, "text")).toMatch(/3.*corrupt/i);
	});

	it("emits parseable json with the runs and the corrupt line count", () => {
		const parsed = JSON.parse(renderRunList({ entries, corruptLines: 2, startFailures: [] }, "json"));
		expect(parsed.corruptLines).toBe(2);
		expect(parsed.runs).toHaveLength(2);
		expect(parsed.runs[0].id).toBe(2);
	});

	it("names the failed starts and the newest reason in text form", () => {
		const output = renderRunList(
			{
				entries,
				corruptLines: 0,
				startFailures: [
					{ ts: "2026-09-09T10:00:00.000Z", reason: "older reason" },
					{ ts: "2026-09-09T11:00:00.000Z", reason: "not a git repository" },
				],
			},
			"text",
		);
		expect(output).toMatch(/2 session\(s\) failed to start/i);
		expect(output).toContain("not a git repository");
	});

	it("says nothing about failed starts when there are none", () => {
		expect(renderRunList({ entries, corruptLines: 0, startFailures: [] }, "text")).not.toMatch(/failed to start/i);
	});

	it("caps the agent format and states how many runs were omitted", () => {
		const many: RunIndexEntry[] = Array.from({ length: 250 }, (_, i) => ({
			id: 250 - i,
			task: `run ${250 - i}`,
			state: "ENDED",
			startedAt: "2026-09-09T10:00:00.000Z",
			endedAt: "2026-09-09T10:05:00.000Z",
		}));
		const output = renderRunList({ entries: many, corruptLines: 0, startFailures: [] }, "agent");
		const lines = output.split("\n");
		expect(lines.length).toBeLessThan(15);
		expect(output).toMatch(/240 more run/);
	});

	it("does not omit anything in agent format when the list is short", () => {
		const output = renderRunList({ entries, corruptLines: 0, startFailures: [] }, "agent");
		expect(output).not.toMatch(/omitted/i);
		expect(output).toContain("first run");
	});
});
