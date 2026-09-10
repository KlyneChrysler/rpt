import { loadConfig } from "../config/load.js";
import type { DraftEvent, RunId } from "../domain/events.js";
import type { AgentRun } from "../domain/run.js";
import type { RunState } from "../domain/state.js";
import { decideVerdict, type Verdict } from "../domain/verdict.js";
import { openWorktree, type Worktree } from "../git/worktree.js";
import { appendEvent } from "../store/eventLog.js";
import { rptDirOf } from "../store/paths.js";
import { listRuns, upsertRun } from "../store/runIndex.js";
import { readVerdict as readVerdictFile, writeVerdict } from "../store/verdicts.js";
import { diffIntegrityVerifier } from "../verifiers/DiffIntegrityVerifier.js";
import { securityVerifier } from "../verifiers/SecurityVerifier.js";
import { testQualityVerifier } from "../verifiers/TestQualityVerifier.js";
import { testVerifier } from "../verifiers/TestVerifier.js";
import { runVerifiers, type RunContext } from "../verifiers/Verifier.js";
import { loadRun } from "./loadRun.js";

const VERIFIERS = [testVerifier, diffIntegrityVerifier, securityVerifier, testQualityVerifier];

// States a run passes through on the way to a verdict, before there is one to
// protect. Once the index has moved past this set - approval, recording,
// arriving in a later plan - an idempotent retry must not drag it back down by
// re-asserting the verdict's own state over top of it. See reconcileIndex.
const PRE_VERDICT_STATES: ReadonlySet<RunState> = new Set(["RUNNING", "ENDED", "VERIFYING"]);

export async function verifyRun(repoRoot: string, runId: RunId): Promise<Verdict> {
	const rptDir = rptDirOf(repoRoot);
	const run = await loadRun(repoRoot, runId);

	// A run that never reached AgentStopped has no sealed end state at all - it
	// was never a candidate for verification, let alone one that was attempted
	// and interrupted. Checked first, ahead of the idempotence guard below: both
	// situations present as "state !== ENDED" from the outside, but they have
	// different true causes and need different messages - conflating them once
	// invented a history ("a previous attempt was interrupted") for a run that
	// was never touched.
	if (run.baseSha === null || run.endSha === null) {
		throw new Error(`run ${runId} has no sealed end state, so it cannot be verified`);
	}

	// verifyRun is the only code path that can produce a verdict, so retrying it
	// is the natural response to a crash mid-verification - and that means a
	// second call has to be safe. A sealed run already past ENDED (mid-
	// verification, or long since resolved) must not re-enter: appending a
	// second VerificationStarted would attempt an illegal VERIFYING -> VERIFYING
	// transition. That doesn't fail here - appendEvent doesn't validate
	// transitions - it fails on every future read of this run's log, since
	// projectRun folds the whole log on every load. Idempotent instead: a
	// recorded verdict is returned as-is, after reconcileIndex re-asserts the
	// index row for it - that makes retry the correct, complete recovery action
	// for a crash between writing the verdict and updating the index, not just a
	// safe no-op. A run with no verdict yet has no prior attempt to resume from
	// safely, so that case fails loudly instead of guessing.
	if (run.state !== "ENDED") {
		const existing = await readVerdictFile(rptDir, runId);
		if (existing === null) {
			throw new Error(
				`run ${runId} is in state ${run.state} with no recorded verdict - a previous verification attempt was interrupted before one was written, so this run cannot be safely re-verified automatically`,
			);
		}
		await reconcileIndex(rptDir, run, existing);
		return existing;
	}

	await appendEvent(rptDir, runId, marker("VerificationStarted", {}));
	await upsertRun(rptDir, { id: runId, task: run.task, state: "VERIFYING", startedAt: run.startedAt, endedAt: run.endedAt });

	const worktree = await openWorktree(repoRoot, run.endSha);
	let verdict: Verdict;
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

		verdict = {
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
	} catch (error) {
		// Guarded so a disposal failure here cannot supersede the real cause of
		// failure above it: without this, a verdict write failure would reach the
		// caller reported as a worktree removal failure instead, and the actual
		// diagnosis would be gone. The disposal failure is still surfaced - to
		// stderr - rather than silently dropped.
		await disposeQuietly(worktree, runId, error);
		throw error;
	}
	// Disposed unguarded on the success path: there is no pending error here for
	// a disposal failure to supersede, so it should surface normally - a leaked
	// worktree is a real, actionable problem and this is the one place nothing
	// else will report it.
	await worktree.dispose();
	return verdict;
}

export async function readVerdict(repoRoot: string, runId: RunId): Promise<Verdict | null> {
	return readVerdictFile(rptDirOf(repoRoot), runId);
}

// Re-asserts the recorded verdict onto the index row - but only while the
// index is still at or behind the verifying stage. Nothing writes the index
// past VERIFYING/VERIFIED/FAILED/UNVERIFIED today, but a later plan's approval
// and recording steps will, and once a run has moved on to AWAITING_APPROVAL
// or further, a stray retry of this verification call must not drag it back
// down to its old verdict state.
async function reconcileIndex(rptDir: string, run: AgentRun, verdict: Verdict): Promise<void> {
	const current = (await listRuns(rptDir)).find((entry) => entry.id === run.id);
	if (current !== undefined && !PRE_VERDICT_STATES.has(current.state)) return;
	await upsertRun(rptDir, { id: run.id, task: run.task, state: verdict.name, startedAt: run.startedAt, endedAt: run.endedAt });
}

export async function disposeQuietly(worktree: Worktree, runId: RunId, pendingError: unknown): Promise<void> {
	try {
		await worktree.dispose();
	} catch (disposeError) {
		process.stderr.write(
			`rpt: failed to dispose worktree for run ${runId} while handling an earlier verification failure (${errorMessage(pendingError)}): ${errorMessage(disposeError)}\n`,
		);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function marker(kind: "VerificationStarted" | "VerifierCompleted", payload: Record<string, unknown>): DraftEvent {
	return { ts: new Date().toISOString(), source: "rpt", kind, payload };
}
