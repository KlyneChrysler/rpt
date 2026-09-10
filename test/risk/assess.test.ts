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
	configChangedSinceSnapshot: false,
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

	it("charges thirty when the config drifted from this run's snapshot", () => {
		const assessment = assessRisk(facts({ configChangedSinceSnapshot: true }), DEFAULT_CONFIG);
		expect(assessment.contributions.find((entry) => entry.id === "rpt-config-changed")?.points).toBe(30);
	});

	it("does not charge the config-changed rule when nothing drifted", () => {
		const assessment = assessRisk(facts({ configChangedSinceSnapshot: false }), DEFAULT_CONFIG);
		expect(assessment.contributions.find((entry) => entry.id === "rpt-config-changed")).toBeUndefined();
	});

	// The timing gap this rule used to miss: an edit to rpt.config.json made
	// after the run's own diff was sealed (so it never appears in
	// pathsChanged) still drifts the live config away from the snapshot, and
	// still has to score.
	it("still charges when the edit falls entirely outside the sealed diff", () => {
		const assessment = assessRisk(facts({ pathsChanged: [], configChangedSinceSnapshot: true }), DEFAULT_CONFIG);
		expect(assessment.contributions.find((entry) => entry.id === "rpt-config-changed")?.points).toBe(30);
	});

	it("credits added regression tests", () => {
		// clean's coverage (measured 20, fraction 1) is high, so it does not
		// contradict the credit - see the "tests-added credit" describe block
		// below for the cases where measured coverage does contradict it.
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

	it("honours a config override that raises a positive rule's points", () => {
		const config = { ...DEFAULT_CONFIG, ruleOverrides: { "dependency-changed": 30 } };
		const assessment = assessRisk(facts({ dependencyChanged: true }), config);
		expect(assessment.contributions.find((entry) => entry.id === "dependency-changed")?.points).toBe(30);
	});

	// The attack this closes: emptying config.sensitivePaths defeats the
	// sensitive-path rules by starving their `when` clause of a match; an
	// override that lowers a positive rule's points is the same attack
	// through the field next door, at the same cost. An override may raise a
	// positive rule's contribution, never lower it below what the rule's own
	// finding already established.
	it("floors a positive rule's override at the rule's own baseline rather than letting it lower the score", () => {
		const config = { ...DEFAULT_CONFIG, ruleOverrides: { "dependency-changed": 5 } };
		const assessment = assessRisk(facts({ dependencyChanged: true }), config);
		expect(assessment.contributions.find((entry) => entry.id === "dependency-changed")?.points).toBe(20);
	});

	it("floors an override of zero on a positive rule at the rule's baseline, not at zero", () => {
		const config = { ...DEFAULT_CONFIG, ruleOverrides: { "sensitive-auth": 0 } };
		const assessment = assessRisk(facts({ sensitiveMatches: [{ category: "auth", paths: ["a"] }] }), config);
		expect(assessment.contributions.find((entry) => entry.id === "sensitive-auth")?.points).toBe(25);
	});

	it("still lets a credit rule's override go as low as zero, unaffected by the positive-rule floor", () => {
		const config = { ...DEFAULT_CONFIG, ruleOverrides: { "tests-added": 0 } };
		const assessment = assessRisk(facts({ testsAdded: 2 }), config);
		expect(assessment.contributions.find((entry) => entry.id === "tests-added")?.points).toBe(0);
	});

	it("floors the function-valued files-changed-count rule's override at whatever it would have scored", () => {
		const config = { ...DEFAULT_CONFIG, ruleOverrides: { "files-changed-count": 1 } };
		const assessment = assessRisk(facts({ fileCount: 6 }), config);
		expect(assessment.contributions.find((entry) => entry.id === "files-changed-count")?.points).toBe(6);
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

	describe("tests-added credit versus measured coverage", () => {
		// A test file existing is weak evidence on its own: nothing checks it
		// asserts anything or exercises the change at all, so a trivial test
		// file could otherwise buy ten points off a genuinely risky change.
		// Real measured coverage is strong evidence and must be able to
		// contradict that weak signal - but only when it was actually measured
		// widely enough to trust (the same floor coverage-high uses).
		it("keeps the credit when coverage was never measured", () => {
			const assessment = assessRisk(
				facts({ testsAdded: 1, changeCoverage: null, changeCoverageLinesMeasured: 0, changeCoverageLinesCovered: 0 }),
				DEFAULT_CONFIG,
			);
			expect(assessment.contributions.find((entry) => entry.id === "tests-added")?.points).toBe(-10);
		});

		it("keeps the credit when coverage was measured and came back high", () => {
			const assessment = assessRisk(
				facts({ testsAdded: 1, changeCoverage: 1, changeCoverageLinesMeasured: 10, changeCoverageLinesCovered: 10 }),
				DEFAULT_CONFIG,
			);
			expect(assessment.contributions.find((entry) => entry.id === "tests-added")?.points).toBe(-10);
		});

		it("withholds the credit when coverage was measured and came back poor", () => {
			const assessment = assessRisk(
				facts({ testsAdded: 1, changeCoverage: 0.2, changeCoverageLinesMeasured: 50, changeCoverageLinesCovered: 10 }),
				DEFAULT_CONFIG,
			);
			expect(assessment.contributions.find((entry) => entry.id === "tests-added")).toBeUndefined();
		});
	});
});
