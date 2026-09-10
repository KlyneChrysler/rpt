import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { changedLines } from "../git/diff.js";
import { parseLcov } from "./lcov.js";
import { linkDependencies, unlinkDependencies } from "./nodeModulesLink.js";
import { failed, passed, type RunContext, type Verifier, type VerifierResult } from "./Verifier.js";

const run = promisify(exec);
const TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const MIN_CHANGE_COVERAGE = 0.5;

export const testQualityVerifier: Verifier = {
	id: "test-quality",
	async run(context: RunContext): Promise<VerifierResult> {
		if (context.config.verifiers.testQuality === "off") return skippedWithFacts("disabled in config", {});
		const command = context.config.coverageCommand;
		if (command === null) return skippedWithFacts("no coverage command configured", {});

		const link = await linkDependencies(context.repoRoot, context.worktree);
		if (link.status === "unavailable") return skippedWithFacts(link.reason, {});

		try {
			await runQuietly(command, context.worktree);
			const lcov = await readLcov(context.worktree);
			if (lcov === null) return skippedWithFacts("coverage run produced no coverage/lcov.info", {});
			return await judge(context, lcov);
		} finally {
			await unlinkDependencies(link);
		}
	},
};

type Totals = { changedLineCount: number; coveredLineCount: number; unmeasuredLineCount: number };

async function judge(context: RunContext, lcov: string): Promise<VerifierResult> {
	const covered = parseLcov(lcov);
	const changed = await changedLines(context.repoRoot, context.baseSha, context.endSha);
	const totals = tally(changed, covered);

	if (totals.changedLineCount === 0) {
		if (totals.unmeasuredLineCount > 0) {
			// Every changed line falls in a file the coverage tool has no record
			// for at all - rpt never observed anything about them, so the honest
			// status is skipped, not a pass that would flatter the change or a
			// fail that would blame the agent for a gap in the tooling.
			return skippedWithFacts(
				`coverage data did not include any of the ${totals.unmeasuredLineCount} changed line(s); cannot verify test quality`,
				{ ...totals, changeCoverage: null },
			);
		}
		return passed("test-quality", { ...totals, changeCoverage: null });
	}

	const changeCoverage = totals.coveredLineCount / totals.changedLineCount;
	const facts = { ...totals, changeCoverage };
	if (changeCoverage >= MIN_CHANGE_COVERAGE) return passed("test-quality", facts);

	const reason = `tests executed only ${Math.round(changeCoverage * 100)}% of changed lines`;
	if (context.config.verifiers.testQuality === "warn") {
		// Warn mode must not let a genuine observation go silent: status stays
		// "passed" so it does not block the run on its own, but the reason
		// states the shortfall instead of the null reason a quiet pass carries -
		// the number is also still in facts.changeCoverage for the risk engine.
		return { id: "test-quality", status: "passed", reason, facts };
	}
	return failed("test-quality", reason, facts);
}

// Deliberately excludes any file the coverage tool has no record for at all
// from both sides of the fraction. Treating an unmeasured file's lines as
// uncovered would damn a change for a gap in the tooling, not the tests;
// treating them as covered would flatter it just as wrongly. They are still
// reported, via unmeasuredLineCount, rather than silently dropped.
function tally(changed: Map<string, Set<number>>, covered: Map<string, Set<number>>): Totals {
	let changedLineCount = 0;
	let coveredLineCount = 0;
	let unmeasuredLineCount = 0;
	for (const [file, lines] of changed) {
		const hits = covered.get(file);
		if (hits === undefined) {
			unmeasuredLineCount += lines.size;
			continue;
		}
		changedLineCount += lines.size;
		for (const line of lines) if (hits.has(line)) coveredLineCount += 1;
	}
	return { changedLineCount, coveredLineCount, unmeasuredLineCount };
}

// Ignores the coverage command's own exit status on purpose: the test
// verifier already owns the pass/fail judgement of the suite itself, this
// verifier only needs whatever coverage artefact the run left behind. A
// command that fails to produce one is caught by readLcov returning null.
async function runQuietly(command: string, cwd: string): Promise<void> {
	try {
		await run(command, { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES });
	} catch {
		return;
	}
}

async function readLcov(worktree: string): Promise<string | null> {
	try {
		return await readFile(join(worktree, "coverage", "lcov.info"), "utf8");
	} catch {
		return null;
	}
}

function skippedWithFacts(reason: string, facts: Record<string, unknown>): VerifierResult {
	return { id: "test-quality", status: "skipped", reason, facts };
}
