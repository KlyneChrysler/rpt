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

export const DEFAULT_RULES: readonly RiskRule[] = [
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
	{ id: "tests-added", label: "Regression tests added", points: -10, when: (facts) => facts.testsAdded > 0 },
	{ id: "tests-passed", label: "All tests passed", points: -5, when: (facts) => facts.testResult === "passed" },
	{ id: "scan-clean", label: "Security scan clean", points: -10, when: (facts) => facts.scanResult === "clean" },
	{
		id: "coverage-high",
		label: "Change coverage above eighty percent",
		points: -5,
		when: (facts) => facts.changeCoverageLinesMeasured >= MIN_MEASURED_LINES_FOR_COVERAGE_CREDIT && (facts.changeCoverage ?? 0) > 0.8,
	},
];
