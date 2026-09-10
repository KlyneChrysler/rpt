import { loadConfig } from "../config/load.js";
import type { DraftEvent, RunId } from "../domain/events.js";
import { decideVerdict, type Verdict } from "../domain/verdict.js";
import { openWorktree } from "../git/worktree.js";
import { appendEvent } from "../store/eventLog.js";
import { rptDirOf } from "../store/paths.js";
import { upsertRun } from "../store/runIndex.js";
import { readVerdict as readVerdictFile, writeVerdict } from "../store/verdicts.js";
import { diffIntegrityVerifier } from "../verifiers/DiffIntegrityVerifier.js";
import { securityVerifier } from "../verifiers/SecurityVerifier.js";
import { testQualityVerifier } from "../verifiers/TestQualityVerifier.js";
import { testVerifier } from "../verifiers/TestVerifier.js";
import { runVerifiers, type RunContext } from "../verifiers/Verifier.js";
import { loadRun } from "./loadRun.js";

const VERIFIERS = [testVerifier, diffIntegrityVerifier, securityVerifier, testQualityVerifier];

export async function verifyRun(repoRoot: string, runId: RunId): Promise<Verdict> {
	const run = await loadRun(repoRoot, runId);
	if (run.baseSha === null || run.endSha === null) {
		throw new Error(`run ${runId} has no sealed end state, so it cannot be verified`);
	}
	const rptDir = rptDirOf(repoRoot);
	await appendEvent(rptDir, runId, marker("VerificationStarted", {}));
	await upsertRun(rptDir, { id: runId, task: run.task, state: "VERIFYING", startedAt: run.startedAt, endedAt: run.endedAt });

	// Disposed in `finally` so a verifier throwing, or any other in-process
	// failure between here and the end of this function, cannot leak it - a
	// leaked worktree makes the next run's `git worktree add` fail outright.
	// A hard kill (SIGKILL) cannot be caught by any JS-level construct; that
	// case is covered on the next run instead, by the stale-worktree recovery
	// already built into openWorktree/dispose (src/git/worktree.ts).
	const worktree = await openWorktree(repoRoot, run.endSha);
	try {
		const context: RunContext = {
			repoRoot,
			worktree: worktree.path,
			baseSha: run.baseSha,
			endSha: run.endSha,
			config: await loadConfig(repoRoot),
			claims: run.claims,
		};
		const results = await runVerifiers(VERIFIERS, context);
		for (const result of results) await appendEvent(rptDir, runId, marker("VerifierCompleted", { ...result }));

		const verdict: Verdict = {
			runId,
			name: decideVerdict(results, run.hasGaps),
			results,
			decidedAt: new Date().toISOString(),
		};
		// Verdict written before the index row: a crash between the two leaves a
		// recoverable state (a durable verdict the index hasn't caught up to yet)
		// rather than an index claiming a verdict that was never recorded.
		await writeVerdict(rptDir, verdict);
		await upsertRun(rptDir, { id: runId, task: run.task, state: verdict.name, startedAt: run.startedAt, endedAt: run.endedAt });
		return verdict;
	} finally {
		await worktree.dispose();
	}
}

export async function readVerdict(repoRoot: string, runId: RunId): Promise<Verdict | null> {
	return readVerdictFile(rptDirOf(repoRoot), runId);
}

function marker(kind: "VerificationStarted" | "VerifierCompleted", payload: Record<string, unknown>): DraftEvent {
	return { ts: new Date().toISOString(), source: "rpt", kind, payload };
}
