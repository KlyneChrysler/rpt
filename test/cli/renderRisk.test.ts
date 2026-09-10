import { describe, expect, it } from "vitest";
import { renderRisk, renderVerdict } from "../../src/cli/renderRisk.js";
import type { Verdict } from "../../src/domain/verdict.js";
import type { RiskAssessment } from "../../src/risk/assess.js";

const assessment: RiskAssessment = {
	score: 47,
	level: "MEDIUM",
	contributions: [
		{ id: "sensitive-auth", label: "Authentication or authorization paths modified", points: 25 },
		{ id: "tests-added", label: "Regression tests added", points: -10 },
	],
};

const verdict: Verdict = {
	runId: 1,
	name: "UNVERIFIED",
	results: [{ id: "tests", status: "skipped", reason: "no test command", facts: {} }],
	decidedAt: "2026-09-09T10:00:00.000Z",
};

describe("renderRisk", () => {
	it("shows the score and level", () => {
		expect(renderRisk(assessment, "text")).toContain("47");
		expect(renderRisk(assessment, "text")).toContain("MEDIUM");
	});

	it("lists every contribution with its sign", () => {
		const output = renderRisk(assessment, "text");
		expect(output).toContain("+25");
		expect(output).toContain("-10");
	});

	it("emits parseable json", () => {
		expect(JSON.parse(renderRisk(assessment, "json")).score).toBe(47);
	});

	it("keeps the agent format under a token budget", () => {
		expect(renderRisk(assessment, "agent").length).toBeLessThan(400);
	});

	it("draws a bar that grows with the score", () => {
		const low = (renderRisk({ ...assessment, score: 10 }, "text").match(/#/g) ?? []).length;
		const high = (renderRisk({ ...assessment, score: 90 }, "text").match(/#/g) ?? []).length;
		expect(high).toBeGreaterThan(low);
	});
});

describe("renderVerdict", () => {
	it("states the reason a verifier was skipped", () => {
		expect(renderVerdict(verdict, "text")).toContain("no test command");
	});

	it("never prints a skipped verifier as a pass", () => {
		expect(renderVerdict(verdict, "text")).not.toMatch(/tests\s+passed/i);
	});

	it("emits parseable json", () => {
		expect(JSON.parse(renderVerdict(verdict, "json")).name).toBe("UNVERIFIED");
	});

	it("names the verdict and every non-passing verifier in the agent format", () => {
		const output = renderVerdict(verdict, "agent");
		expect(output).toContain("UNVERIFIED");
		expect(output).toContain("no test command");
	});

	it("spends no agent context on verifiers that simply passed", () => {
		const passing: Verdict = { ...verdict, name: "VERIFIED", results: [{ id: "tests", status: "passed", reason: null, facts: {} }] };
		expect(renderVerdict(passing, "agent")).toBe("verdict VERIFIED");
	});
});
