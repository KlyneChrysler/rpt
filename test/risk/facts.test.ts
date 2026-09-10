import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/load.js";
import { buildFacts } from "../../src/risk/facts.js";
import type { VerifierResult } from "../../src/domain/verifierResult.js";

function diffResult(facts: Record<string, unknown>): VerifierResult {
	return { id: "diff-integrity", status: "passed", reason: null, facts };
}

function qualityResult(status: VerifierResult["status"], facts: Record<string, unknown>): VerifierResult {
	return { id: "test-quality", status, reason: status === "passed" ? null : "unused in these tests", facts };
}

const emptyDiff = diffResult({ observedPaths: [], undeclared: [], manifestChanged: false, added: 0, removed: 0 });

describe("buildFacts", () => {
	it("counts files, additions and removals from the diff verifier", () => {
		const facts = buildFacts([diffResult({ observedPaths: ["a.ts", "b.ts"], undeclared: [], manifestChanged: false, added: 10, removed: 4 })], DEFAULT_CONFIG);
		expect(facts.fileCount).toBe(2);
		expect(facts.linesAdded).toBe(10);
		expect(facts.linesRemoved).toBe(4);
	});

	it("matches sensitive paths by configured category", () => {
		const facts = buildFacts([diffResult({ observedPaths: ["src/auth/pool.ts", "src/db/migrations/1.sql"], undeclared: [], manifestChanged: false, added: 1, removed: 0 })], DEFAULT_CONFIG);
		expect(facts.sensitiveMatches.map((match) => match.category).sort()).toEqual(["auth", "database"]);
	});

	it("reports no sensitive match for ordinary paths", () => {
		const facts = buildFacts([diffResult({ observedPaths: ["src/ui/Button.tsx"], undeclared: [], manifestChanged: false, added: 1, removed: 0 })], DEFAULT_CONFIG);
		expect(facts.sensitiveMatches).toEqual([]);
	});

	it("carries undeclared files through", () => {
		const facts = buildFacts([diffResult({ observedPaths: ["a.ts"], undeclared: ["a.ts"], manifestChanged: false, added: 1, removed: 0 })], DEFAULT_CONFIG);
		expect(facts.undeclaredFiles).toEqual(["a.ts"]);
	});

	it("maps a passing test verifier to a passed result", () => {
		const tests: VerifierResult = { id: "tests", status: "passed", reason: null, facts: { passed: 184, failed: 0 } };
		expect(buildFacts([emptyDiff, tests], DEFAULT_CONFIG).testResult).toBe("passed");
	});

	it("maps a skipped test verifier to unknown rather than passed", () => {
		const tests: VerifierResult = { id: "tests", status: "skipped", reason: "none found", facts: {} };
		expect(buildFacts([emptyDiff, tests], DEFAULT_CONFIG).testResult).toBe("unknown");
	});

	it("maps a missing test verifier to unknown", () => {
		expect(buildFacts([emptyDiff], DEFAULT_CONFIG).testResult).toBe("unknown");
	});

	it("maps a failing test verifier to a failed result", () => {
		const tests: VerifierResult = { id: "tests", status: "failed", reason: "2 failing", facts: { passed: 180, failed: 2 } };
		expect(buildFacts([emptyDiff, tests], DEFAULT_CONFIG).testResult).toBe("failed");
	});

	it("maps a skipped security verifier to a skipped scan result", () => {
		const security: VerifierResult = { id: "security", status: "skipped", reason: "offline", facts: {} };
		expect(buildFacts([emptyDiff, security], DEFAULT_CONFIG).scanResult).toBe("skipped");
	});

	it("maps a missing security verifier to skipped rather than clean", () => {
		expect(buildFacts([emptyDiff], DEFAULT_CONFIG).scanResult).toBe("skipped");
	});

	it("maps a failing security verifier to findings rather than clean", () => {
		const security: VerifierResult = { id: "security", status: "failed", reason: "1 secret found", facts: { findings: 1 } };
		expect(buildFacts([emptyDiff, security], DEFAULT_CONFIG).scanResult).toBe("findings");
	});

	it("reports null change coverage when the quality verifier could not measure it", () => {
		expect(buildFacts([emptyDiff], DEFAULT_CONFIG).changeCoverage).toBeNull();
	});

	it("counts added test files", () => {
		const facts = buildFacts([diffResult({ observedPaths: ["src/a.ts", "test/a.test.ts", "src/b_test.go"], undeclared: [], manifestChanged: false, added: 1, removed: 0 })], DEFAULT_CONFIG);
		expect(facts.testsAdded).toBe(2);
	});

	it("carries the change coverage fraction and the line counts it was computed from", () => {
		const quality = qualityResult("passed", { changedLineCount: 12, coveredLineCount: 9, unmeasuredLineCount: 0, uninstrumentedLineCount: 3, changeCoverage: 0.75 });
		const facts = buildFacts([emptyDiff, quality], DEFAULT_CONFIG);
		expect(facts.changeCoverage).toBe(0.75);
		expect(facts.changeCoverageLinesMeasured).toBe(12);
		expect(facts.changeCoverageLinesCovered).toBe(9);
	});

	it("exposes a thin denominator instead of hiding it behind a perfect fraction", () => {
		// A single changed line that happened to run: fraction is 1, but the
		// denominator says this proves almost nothing. The risk engine needs the
		// count, not just the ratio, to tell a thin measurement from a solid one.
		const quality = qualityResult("passed", { changedLineCount: 1, coveredLineCount: 1, unmeasuredLineCount: 0, uninstrumentedLineCount: 0, changeCoverage: 1 });
		const facts = buildFacts([emptyDiff, quality], DEFAULT_CONFIG);
		expect(facts.changeCoverage).toBe(1);
		expect(facts.changeCoverageLinesMeasured).toBe(1);
	});

	it("reports zero measured lines when there is no quality verifier result to read counts from", () => {
		const facts = buildFacts([emptyDiff], DEFAULT_CONFIG);
		expect(facts.changeCoverageLinesMeasured).toBe(0);
		expect(facts.changeCoverageLinesCovered).toBe(0);
	});

	it("treats a non-array observedPaths as no paths rather than throwing", () => {
		const facts = buildFacts([diffResult({ observedPaths: null, undeclared: [], manifestChanged: false, added: 0, removed: 0 })], DEFAULT_CONFIG);
		expect(facts.pathsChanged).toEqual([]);
		expect(facts.fileCount).toBe(0);
	});
});
