import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/load.js";
import { assessRisk } from "../../src/risk/assess.js";
import type { RunFacts } from "../../src/risk/facts.js";

const clean: RunFacts = {
	pathsChanged: [],
	fileCount: 0,
	linesAdded: 0,
	linesRemoved: 0,
	sensitiveMatches: [],
	dependencyChanged: false,
	testsAdded: 0,
	testResult: "passed",
	scanResult: "clean",
	changeCoverage: 1,
	changeCoverageLinesMeasured: 20,
	changeCoverageLinesCovered: 20,
	undeclaredFiles: [],
};

function facts(overrides: Partial<RunFacts>): RunFacts {
	return { ...clean, ...overrides };
}

describe("assessRisk", () => {
	it("is deterministic", () => {
		const input = facts({ fileCount: 3 });
		expect(assessRisk(input, DEFAULT_CONFIG)).toEqual(assessRisk(input, DEFAULT_CONFIG));
	});

	it("never scores below zero", () => {
		expect(assessRisk(clean, DEFAULT_CONFIG).score).toBe(0);
	});

	it("never scores above one hundred", () => {
		const worst = facts({
			fileCount: 500,
			sensitiveMatches: [
				{ category: "auth", paths: ["a"] },
				{ category: "database", paths: ["b"] },
				{ category: "infra", paths: ["c"] },
			],
			dependencyChanged: true,
			undeclaredFiles: ["x"],
			testResult: "failed",
			scanResult: "findings",
			changeCoverage: 0,
			changeCoverageLinesMeasured: 0,
			changeCoverageLinesCovered: 0,
		});
		expect(assessRisk(worst, DEFAULT_CONFIG).score).toBe(100);
	});

	it("charges twenty five for an auth change", () => {
		const assessment = assessRisk(facts({ sensitiveMatches: [{ category: "auth", paths: ["src/auth/a.ts"] }] }), DEFAULT_CONFIG);
		expect(assessment.contributions.find((entry) => entry.id === "sensitive-auth")?.points).toBe(25);
	});

	it("caps the per-file charge at ten", () => {
		const assessment = assessRisk(facts({ fileCount: 40 }), DEFAULT_CONFIG);
		expect(assessment.contributions.find((entry) => entry.id === "files-changed-count")?.points).toBe(10);
	});

	it("credits added regression tests", () => {
		const assessment = assessRisk(facts({ testsAdded: 2 }), DEFAULT_CONFIG);
		expect(assessment.contributions.find((entry) => entry.id === "tests-added")?.points).toBe(-10);
	});

	it("bands the score", () => {
		expect(assessRisk(clean, DEFAULT_CONFIG).level).toBe("LOW");
		// Auth touched, a dependency changed, tests unknown, scan skipped: enough
		// severity to clear the approval threshold (51) regardless of whether the
		// coverage credit below also fires, so the HIGH band is unambiguous.
		const risky = facts({
			sensitiveMatches: [{ category: "auth", paths: ["a"] }],
			dependencyChanged: true,
			testResult: "unknown",
			scanResult: "skipped",
		});
		expect(assessRisk(risky, DEFAULT_CONFIG).level).toBe("HIGH");
	});

	it("explains every point it charged", () => {
		const assessment = assessRisk(facts({ fileCount: 7, dependencyChanged: true }), DEFAULT_CONFIG);
		const summed = assessment.contributions.reduce((total, entry) => total + entry.points, 0);
		expect(assessment.score).toBe(Math.min(100, Math.max(0, summed)));
	});

	it("honours a config override of a rule's points", () => {
		const config = { ...DEFAULT_CONFIG, ruleOverrides: { "dependency-changed": 5 } };
		const assessment = assessRisk(facts({ dependencyChanged: true }), config);
		expect(assessment.contributions.find((entry) => entry.id === "dependency-changed")?.points).toBe(5);
	});

	it("rejects an override naming a rule that does not exist", () => {
		const config = { ...DEFAULT_CONFIG, ruleOverrides: { "no-such-rule": 5 } };
		expect(() => assessRisk(clean, config)).toThrow(/no-such-rule/);
	});

	describe("coverage credit's measured-lines floor", () => {
		// A verifier can legitimately report changeCoverage: 1 from a single
		// instrumented line that happened to run - a perfect fraction that
		// proves almost nothing. Below ten measured lines, one line's outcome
		// swings the fraction by more than ten percentage points, so the credit
		// must not fire until the sample is at least that wide.
		it("withholds the credit when only one line was measured", () => {
			const assessment = assessRisk(
				facts({ changeCoverage: 1, changeCoverageLinesMeasured: 1, changeCoverageLinesCovered: 1 }),
				DEFAULT_CONFIG,
			);
			expect(assessment.contributions.find((entry) => entry.id === "coverage-high")).toBeUndefined();
		});

		it("withholds the credit one line short of the floor", () => {
			const assessment = assessRisk(
				facts({ changeCoverage: 1, changeCoverageLinesMeasured: 9, changeCoverageLinesCovered: 9 }),
				DEFAULT_CONFIG,
			);
			expect(assessment.contributions.find((entry) => entry.id === "coverage-high")).toBeUndefined();
		});

		it("grants the credit once the floor is met", () => {
			const assessment = assessRisk(
				facts({ changeCoverage: 1, changeCoverageLinesMeasured: 10, changeCoverageLinesCovered: 10 }),
				DEFAULT_CONFIG,
			);
			expect(assessment.contributions.find((entry) => entry.id === "coverage-high")?.points).toBe(-5);
		});

		it("still requires the fraction itself to be above eighty percent", () => {
			const assessment = assessRisk(
				facts({ changeCoverage: 0.5, changeCoverageLinesMeasured: 100, changeCoverageLinesCovered: 50 }),
				DEFAULT_CONFIG,
			);
			expect(assessment.contributions.find((entry) => entry.id === "coverage-high")).toBeUndefined();
		});
	});
});
