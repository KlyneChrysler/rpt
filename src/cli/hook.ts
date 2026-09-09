import { claudeCodeAdapter } from "../collectors/claudeCode.js";
import type { DraftEvent } from "../domain/events.js";
import { endRun, NoRunInProgressError } from "../app/endRun.js";
import { recordEvent } from "../app/recordEvent.js";
import { startRun } from "../app/startRun.js";
import { rptDirOf } from "../store/paths.js";
import { recordStartFailure } from "../store/startFailures.js";

export async function handleHook(repoRoot: string, raw: unknown): Promise<void> {
	for (const draft of claudeCodeAdapter.normalize(raw)) {
		if (draft.kind === "RunStarted") {
			await startNewRun(repoRoot, draft);
			continue;
		}
		if (draft.kind === "AgentStopped") {
			await sealActiveRun(repoRoot);
			continue;
		}
		await recordEvent(repoRoot, draft);
	}
}

// Controller ruling: real SessionStart payloads carry no task field at all, so none
// is invented here - startRun gets "" and projectRun derives the task later from the
// first prompt. A RunStarted while a run is already open - its Stop hook never fired
// (a crash, or the process was killed), or this is a mid-session SessionStart such as
// compact/clear (the fixtures carry a `source` field the adapter does not forward) -
// seals the stale run first, rather than leaving it open forever while a new run
// silently takes over the current-run pointer. endRun's own atomicity (see
// src/store/currentRun.ts) makes this safe even if it races a concurrent seal of the
// same run.
async function startNewRun(repoRoot: string, draft: DraftEvent): Promise<void> {
	await sealActiveRun(repoRoot);
	try {
		await startRun(repoRoot, {
			task: asStringOrNull(draft.payload.task) ?? "",
			transcriptPath: asStringOrNull(draft.payload.transcriptPath),
		});
	} catch (error) {
		await noteStartFailure(repoRoot, error);
		throw error;
	}
}

// A start that fails takes the whole session with it: no run is opened, so every
// later hook finds no current run and returns, and the session records nothing
// while the listing shows nothing wrong. The stderr trace runHookCommand writes
// dies with the hook process; this is the copy that outlives it and reaches
// `rpt runs`. It is best-effort by necessity - if .rpt itself cannot be written
// there is nowhere left to record anything - so its own failure is traced and the
// original error still propagates.
async function noteStartFailure(repoRoot: string, error: unknown): Promise<void> {
	try {
		await recordStartFailure(rptDirOf(repoRoot), messageOf(error));
	} catch (writeError) {
		process.stderr.write(`rpt hook: could not record the failed run start: ${messageOf(writeError)}\n`);
	}
}

// A run is sealed exactly once. endRun's transition is atomic against the
// current-run pointer, so a duplicate Stop - or one with no run in progress at
// all, or one racing a concurrent Stop for the same run - surfaces as
// NoRunInProgressError: already handled, not an error to report.
async function sealActiveRun(repoRoot: string): Promise<void> {
	try {
		await endRun(repoRoot);
	} catch (error) {
		if (!(error instanceof NoRunInProgressError)) throw error;
	}
}

export async function runHookCommand(repoRoot: string, stdin: string): Promise<number> {
	try {
		await handleHook(repoRoot, JSON.parse(stdin));
	} catch (error) {
		process.stderr.write(`rpt hook: ${messageOf(error)}\n`);
	}
	return 0;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function asStringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}
