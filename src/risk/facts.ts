import picomatch from "picomatch";
import type { RptConfig } from "../config/schema.js";
import type { VerifierResult } from "../domain/verifierResult.js";

export type SensitiveMatch = { category: string; paths: string[] };

export type RunFacts = {
	pathsChanged: string[];
	fileCount: number;
	linesAdded: number;
	linesRemoved: number;
	sensitiveMatches: SensitiveMatch[];
	dependencyChanged: boolean;
	testsAdded: number;
	testResult: "passed" | "failed" | "unknown";
	scanResult: "clean" | "findings" | "skipped";
	changeCoverage: number | null;
	changeCoverageLinesMeasured: number;
	changeCoverageLinesCovered: number;
	undeclaredFiles: string[];
	// Whether rpt.config.json, read live right now, still matches the
	// snapshot this run's score is otherwise being assessed against. Not
	// derived from the sealed diff (pathsChanged) on purpose: an edit made
	// after the run's end snapshot was captured, but before verification or
	// approval runs, never appears in that diff at all - exactly the timing
	// an attacker aiming to avoid the config-changed finding would choose.
	// This is computed outside this pure module (it needs a second, live
	// disk read to compare against) and passed in already decided.
	configChangedSinceSnapshot: boolean;
};

const TEST_FILE = /(^|\/)(test|tests|spec|__tests__)\//i;
const TEST_NAME = /\.(test|spec)\.[a-z]+$|_test\.[a-z]+$/i;

export function buildFacts(
	results: readonly VerifierResult[],
	config: RptConfig,
	configChangedSinceSnapshot = false,
): RunFacts {
	const diff = factsOf(results, "diff-integrity");
	const pathsChanged = stringsOf(diff.observedPaths);
	const coverage = coverageOf(results);
	return {
		pathsChanged,
		fileCount: pathsChanged.length,
		linesAdded: numberOf(diff.added),
		linesRemoved: numberOf(diff.removed),
		sensitiveMatches: matchSensitive(pathsChanged, config),
		dependencyChanged: diff.manifestChanged === true,
		testsAdded: pathsChanged.filter(isTestFile).length,
		testResult: testResultOf(results),
		scanResult: scanResultOf(results),
		changeCoverage: coverage.fraction,
		changeCoverageLinesMeasured: coverage.measured,
		changeCoverageLinesCovered: coverage.covered,
		undeclaredFiles: stringsOf(diff.undeclared),
		configChangedSinceSnapshot,
	};
}

// Case-insensitive on purpose: macOS and Windows resolve paths without
// regard to case, so a sensitive directory or file renamed only in its
// casing is still the same file on disk, still in scope, and must still
// match. Matching case-sensitively would let such a rename silently drop
// out of sensitiveMatches while nothing about the file's real location
// changed - under-matching lowers a risk score for the exact class of
// change the score exists to catch. Case-insensitive matching can only
// over-match instead, which can only raise a score, and over-matching is
// the direction this project accepts being wrong in.
function matchSensitive(paths: readonly string[], config: RptConfig): SensitiveMatch[] {
	return Object.entries(config.sensitivePaths)
		.map(([category, globs]) => ({ category, paths: paths.filter(picomatch(globs, { dot: true, nocase: true })) }))
		.filter((match) => match.paths.length > 0);
}

function testResultOf(results: readonly VerifierResult[]): RunFacts["testResult"] {
	const tests = results.find((result) => result.id === "tests");
	if (tests?.status === "passed") return "passed";
	if (tests?.status === "failed") return "failed";
	return "unknown";
}

function scanResultOf(results: readonly VerifierResult[]): RunFacts["scanResult"] {
	const security = results.find((result) => result.id === "security");
	if (security === undefined || security.status === "skipped") return "skipped";
	return security.status === "passed" ? "clean" : "findings";
}

// The coverage verifier (test-quality) publishes changedLineCount and
// coveredLineCount alongside the changeCoverage fraction it derives them
// from - see src/verifiers/TestQualityVerifier.ts. A fraction alone can lie
// about how much it proves (1 covered of 1 measured reads identically to
// 100 of 100), so the counts are carried through unchanged rather than
// recomputed, letting the risk engine judge whether the denominator is
// large enough for the fraction to mean anything. No result, or one with no
// number to read, maps to zero measured/covered lines: the pessimistic
// reading, since rpt never observed a single line's execution result.
function coverageOf(results: readonly VerifierResult[]): { fraction: number | null; measured: number; covered: number } {
	const facts = factsOf(results, "test-quality");
	const fraction = isFiniteNumber(facts.changeCoverage) ? facts.changeCoverage : null;
	return { fraction, measured: numberOf(facts.changedLineCount), covered: numberOf(facts.coveredLineCount) };
}

function isTestFile(path: string): boolean {
	return TEST_FILE.test(path) || TEST_NAME.test(path);
}

function factsOf(results: readonly VerifierResult[], id: string): Record<string, unknown> {
	return results.find((result) => result.id === id)?.facts ?? {};
}

function stringsOf(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

// A NaN or Infinity from a malformed verifier is not "unknown" in the type
// system's eyes (typeof still says "number"), but it is exactly as
// unusable as a missing value - a helper elsewhere in this plan has already
// shipped one into a published count. Treated the same way a missing
// number is: the pessimistic default, not a value that silently poisons
// downstream arithmetic.
function numberOf(value: unknown): number {
	return isFiniteNumber(value) ? value : 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
