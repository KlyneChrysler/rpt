import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import type { RunDetailModel } from "../../src/app/readModel.js";
import { Diff } from "../../src/ui/screens/Diff.js";
import { Events } from "../../src/ui/screens/Events.js";
import { Risk } from "../../src/ui/screens/Risk.js";
import { RunDetail } from "../../src/ui/screens/RunDetail.js";
import { Tests } from "../../src/ui/screens/Tests.js";

const model: RunDetailModel = {
	run: {
		id: 1842,
		task: "fix authentication timeout",
		state: "VERIFYING",
		baseSha: "a".repeat(40),
		endSha: "b".repeat(40),
		configFingerprint: "c".repeat(64),
		startedAt: "2026-09-09T10:00:00.000Z",
		endedAt: "2026-09-09T10:08:41.000Z",
		hasGaps: false,
		claims: { mutatedPaths: ["src/auth/pool.ts"], commands: ["pnpm test"] },
		usage: [],
	},
	verdict: {
		runId: 1842,
		name: "VERIFIED",
		results: [
			{ id: "tests", status: "passed", reason: null, facts: { passed: 184, failed: 0, command: "pnpm test" } },
			{ id: "security", status: "skipped", reason: "offline", facts: {} },
		],
		decidedAt: "2026-09-09T10:09:00.000Z",
	},
	risk: {
		score: 47,
		level: "MEDIUM",
		contributions: [
			{ id: "sensitive-auth", label: "Authentication or authorization paths modified", points: 25 },
			{ id: "tests-added", label: "Regression tests added", points: -10 },
		],
	},
	approval: null,
	events: [
		{ runId: 1842, seq: 0, ts: "2026-09-09T10:00:00.000Z", source: "rpt", kind: "RunStarted", payload: {} },
		{
			runId: 1842,
			seq: 1,
			ts: "2026-09-09T10:00:42.000Z",
			source: "claude-code",
			kind: "FileMutated",
			payload: { path: "src/auth/pool.ts" },
		},
	],
	costUsd: 1.84,
	unpricedModels: [],
};

function frameOf(element: React.ReactElement): string {
	return render(element).lastFrame() ?? "";
}

describe("RunDetail", () => {
	it("shows the task, duration, cost and risk together", () => {
		const frame = frameOf(<RunDetail model={model} />);
		expect(frame).toContain("fix authentication timeout");
		expect(frame).toContain("08m 41s");
		expect(frame).toContain("1.84");
		expect(frame).toContain("MEDIUM");
	});

	it("shows test counts observed by the verifier", () => {
		expect(frameOf(<RunDetail model={model} />)).toContain("184");
	});

	it("shows a skipped verifier with its reason rather than as a pass", () => {
		const frame = frameOf(<RunDetail model={model} />);
		expect(frame).toContain("skipped");
		expect(frame).toContain("offline");
	});

	it("warns prominently when the log has gaps", () => {
		const gapped = { ...model, run: { ...model.run, hasGaps: true } };
		expect(frameOf(<RunDetail model={gapped} />)).toMatch(/gap/i);
	});

	it("renders a run that has never been verified", () => {
		const bare = { ...model, verdict: null, risk: null };
		expect(frameOf(<RunDetail model={bare} />)).toMatch(/not verified/i);
	});

	it("says a test count is unknown rather than printing zero", () => {
		const unparsed = {
			...model,
			verdict: { ...model.verdict!, results: [{ id: "tests", status: "passed" as const, reason: null, facts: {} }] },
		};
		expect(frameOf(<RunDetail model={unparsed} />)).toContain("unknown");
	});
});

describe("Events", () => {
	it("prints one row per event with a relative offset", () => {
		const frame = frameOf(<Events model={model} />);
		expect(frame).toContain("00:42");
		expect(frame).toContain("FileMutated");
	});

	it("renders a run with no events without crashing", () => {
		expect(frameOf(<Events model={{ ...model, events: [] }} />)).toMatch(/no events/i);
	});
});

describe("Diff", () => {
	it("shows additions and removals", () => {
		const patch = ["+++ b/a.ts", "+added", "-removed"].join("\n");
		const frame = frameOf(<Diff patch={patch} />);
		expect(frame).toContain("+added");
		expect(frame).toContain("-removed");
	});

	it("renders an empty diff without crashing", () => {
		expect(frameOf(<Diff patch="" />)).toMatch(/no observed changes/i);
	});

	it("says how many lines it hid rather than truncating silently", () => {
		const patch = Array.from({ length: 500 }, (_, index) => `+line ${index}`).join("\n");
		expect(frameOf(<Diff patch={patch} />)).toMatch(/100 more line/);
	});
});

describe("Risk", () => {
	it("shows the score and every contribution", () => {
		const frame = frameOf(<Risk model={model} />);
		expect(frame).toContain("47");
		expect(frame).toContain("+25");
		expect(frame).toContain("-10");
	});

	it("says approval is required at HIGH", () => {
		const high = { ...model, risk: { ...model.risk!, score: 67, level: "HIGH" as const } };
		expect(frameOf(<Risk model={high} />)).toMatch(/approval required/i);
	});

	it("says a critical run is blocked outright", () => {
		const critical = { ...model, risk: { ...model.risk!, score: 92, level: "CRITICAL" as const } };
		expect(frameOf(<Risk model={critical} />)).toMatch(/blocked/i);
	});

	it("renders a placeholder when the run has no assessment", () => {
		expect(frameOf(<Risk model={{ ...model, risk: null }} />)).toMatch(/not verified/i);
	});
});

describe("Tests", () => {
	it("shows the counts rpt observed and the command it ran", () => {
		const frame = frameOf(<Tests model={model} />);
		expect(frame).toContain("184");
		expect(frame).toContain("pnpm test");
	});

	it("separates what rpt observed from what the agent claimed", () => {
		const frame = frameOf(<Tests model={model} />);
		expect(frame).toMatch(/OBSERVED BY/);
		expect(frame).toMatch(/CLAIMED BY THE AGENT/);
	});

	it("says a count is unknown rather than printing zero for a reporter it could not parse", () => {
		const unparsed = {
			...model,
			verdict: { ...model.verdict!, results: [{ id: "tests", status: "passed" as const, reason: null, facts: {} }] },
		};
		expect(frameOf(<Tests model={unparsed} />)).toContain("unknown");
	});

	it("shows a check that was never run as not run, never as a pass", () => {
		const partial = {
			...model,
			verdict: { ...model.verdict!, results: [{ id: "tests", status: "passed" as const, reason: null, facts: {} }] },
		};
		const frame = frameOf(<Tests model={partial} />);
		expect(frame).toContain("not run");
	});

	it("tells an unverified run what to do rather than showing an empty screen", () => {
		expect(frameOf(<Tests model={{ ...model, verdict: null, risk: null }} />)).toMatch(/not verified/i);
	});
});
