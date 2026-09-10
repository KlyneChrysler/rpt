import type { RunFacts } from "./facts.js";

export type RiskRule = {
	id: string;
	label: string;
	points: number | ((facts: RunFacts) => number);
	when: (facts: RunFacts) => boolean;
};

const MAX_FILE_POINTS = 10;

// Below this many measured lines, one line's pass/fail outcome swings the
// coverage fraction by more than ten percentage points - too volatile a
// sample to reward. A verifier can legitimately report changeCoverage: 1
// from a single instrumented line that happened to run; that is not
// evidence the change is well tested, it is an artifact of a thin
// denominator. See src/risk/facts.ts for where measured/covered are carried.
const MIN_MEASURED_LINES_FOR_COVERAGE_CREDIT = 10;

function hasCategory(facts: RunFacts, category: string): boolean {
	return facts.sensitiveMatches.some((match) => match.category === category);
}

function coverageWasMeasured(facts: RunFacts): boolean {
	return facts.changeCoverageLinesMeasured >= MIN_MEASURED_LINES_FOR_COVERAGE_CREDIT;
}

function coverageIsHigh(facts: RunFacts): boolean {
	return (facts.changeCoverage ?? 0) > 0.8;
}

// A test file existing is weak evidence on its own - nothing checks that it
// asserts anything or exercises the change at all, so an agent could add one
// trivial test file and take ten points off an otherwise risky change. When
// coverage of the changed lines was actually measured (using the same floor
// as coverage-high, so the two rules agree on what a real measurement is),
// that direct evidence overrides the weak signal: a real, low measured
// number withholds the credit a trivial test file would otherwise buy. When
// coverage was not measured at all, or was measured too thinly to trust,
// there is no direct evidence to contradict testsAdded with, so the credit
// still stands rather than punishing a project with no coverage tooling.
function testsAddedWithoutContradictingCoverage(facts: RunFacts): boolean {
	if (facts.testsAdded <= 0) return false;
	if (!coverageWasMeasured(facts)) return true;
	return coverageIsHigh(facts);
}

export const DEFAULT_RULES: readonly RiskRule[] = [
	// A run that edits rpt.config.json is editing the very thresholds and
	// overrides its own score will be judged against, using loadConfig's own
	// live read of that file - the config schema's [0, 100] cap and the
	// overrides floor (config/schema.ts) bound how far that can go, but this
	// rule makes the edit itself a scored, visible finding rather than an
	// invisible one, on the same footing as the other sensitive-path rules.
	{ id: "rpt-config-changed", label: "rpt's own configuration file was modified", points: 30, when: (facts) => facts.pathsChanged.includes("rpt.config.json") },
	{ id: "sensitive-auth", label: "Authentication or authorization paths modified", points: 25, when: (facts) => hasCategory(facts, "auth") },
	{ id: "sensitive-database", label: "Database access or migration paths modified", points: 20, when: (facts) => hasCategory(facts, "database") },
	{ id: "sensitive-infra", label: "Infrastructure or deployment paths modified", points: 20, when: (facts) => hasCategory(facts, "infra") },
	{ id: "dependency-changed", label: "Production dependency changed", points: 20, when: (facts) => facts.dependencyChanged },
	{ id: "undeclared-files", label: "Undeclared files in diff", points: 15, when: (facts) => facts.undeclaredFiles.length > 0 },
	{ id: "files-changed-bulk", label: "More than ten files changed", points: 10, when: (facts) => facts.fileCount > 10 },
	{ id: "files-changed-count", label: "Files changed", points: (facts) => Math.min(facts.fileCount, MAX_FILE_POINTS), when: (facts) => facts.fileCount > 0 },
	{ id: "scan-findings", label: "Security scan produced findings", points: 25, when: (facts) => facts.scanResult === "findings" },
	{ id: "scan-skipped", label: "Security scan skipped", points: 10, when: (facts) => facts.scanResult === "skipped" },
	{ id: "tests-unknown-or-failing", label: "Test result unknown or failing", points: 15, when: (facts) => facts.testResult !== "passed" },
	{ id: "tests-added", label: "Regression tests added", points: -10, when: testsAddedWithoutContradictingCoverage },
	{ id: "tests-passed", label: "All tests passed", points: -5, when: (facts) => facts.testResult === "passed" },
	{ id: "scan-clean", label: "Security scan clean", points: -10, when: (facts) => facts.scanResult === "clean" },
	{
		id: "coverage-high",
		label: "Change coverage above eighty percent",
		points: -5,
		when: (facts) => coverageWasMeasured(facts) && coverageIsHigh(facts),
	},
];
