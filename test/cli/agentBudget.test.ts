import { describe, expect, it } from "vitest";
import { renderRun } from "../../src/cli/render.js";
import { renderRisk, renderVerdict } from "../../src/cli/renderRisk.js";
import type { AgentRun } from "../../src/domain/run.js";
import type { Verdict } from "../../src/domain/verdict.js";
import type { RiskAssessment } from "../../src/risk/assess.js";

const bigRun: AgentRun = {
	id: 1842,
	task: "x".repeat(300),
	state: "VERIFYING",
	baseSha: "a".repeat(40),
	endSha: "b".repeat(40),
	configFingerprint: "c".repeat(64),
	startedAt: "2026-09-09T10:00:00.000Z",
	endedAt: "2026-09-09T10:08:41.000Z",
	hasGaps: false,
	claims: {
		mutatedPaths: Array.from({ length: 300 }, (_, index) => `src/deep/nested/path/file-${index}.ts`),
		commands: Array.from({ length: 200 }, (_, index) => `command ${index}`),
	},
	usage: [],
};

const bigRisk: RiskAssessment = {
	score: 88,
	level: "CRITICAL",
	contributions: Array.from({ length: 40 }, (_, index) => ({
		id: `rule-${index}`,
		label: "A fairly long human readable rule label that would bloat output",
		points: index,
	})),
};

const bigVerdict: Verdict = {
	runId: 1842,
	name: "UNVERIFIED",
	results: Array.from({ length: 40 }, (_, index) => ({
		id: `verifier-${index}`,
		status: "passed" as const,
		reason: null,
		facts: {},
	})),
	decidedAt: "2026-09-09T10:09:00.000Z",
};

describe("agent output budget", () => {
	it("keeps a run summary under 600 characters however large the run", () => {
		expect(renderRun(bigRun, "agent").length).toBeLessThan(600);
	});

	it("keeps a risk summary under 800 characters however many rules fired", () => {
		expect(renderRisk(bigRisk, "agent").length).toBeLessThan(800);
	});

	it("still names the score and level after truncation", () => {
		const output = renderRisk(bigRisk, "agent");
		expect(output).toContain("88");
		expect(output).toContain("CRITICAL");
	});

	it("says how much was elided rather than truncating silently", () => {
		expect(renderRisk(bigRisk, "agent")).toMatch(/\d+ more/);
	});

	it("keeps the rules that moved the score most, not the ones declared first", () => {
		expect(renderRisk(bigRisk, "agent")).toContain("rule-39");
	});

	it("keeps a verdict summary small when every verifier passed", () => {
		expect(renderVerdict(bigVerdict, "agent").length).toBeLessThan(200);
	});

	it("never truncates the run id or the state", () => {
		const output = renderRun(bigRun, "agent");
		expect(output).toContain("1842");
		expect(output).toContain("VERIFYING");
	});
});
