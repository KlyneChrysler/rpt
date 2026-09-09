import { claudeCodeAdapter } from "../collectors/claudeCode.js";
import type { DraftEvent } from "../domain/events.js";
import { endRun } from "../app/endRun.js";
import { currentRunId } from "../app/loadRun.js";
import { recordEvent } from "../app/recordEvent.js";
import { startRun } from "../app/startRun.js";

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
// first prompt. A RunStarted while a run is already open means that run's Stop hook
// never fired (a crash, or the process was killed): the current-run pointer only
// ever names one run, so the stale run is sealed first rather than left open forever
// with a new run silently taking over the pointer and every event after it.
async function startNewRun(repoRoot: string, draft: DraftEvent): Promise<void> {
	if ((await currentRunId(repoRoot)) !== null) await endRun(repoRoot);
	await startRun(repoRoot, {
		task: asStringOrNull(draft.payload.task) ?? "",
		transcriptPath: asStringOrNull(draft.payload.transcriptPath),
	});
}

// A run is sealed exactly once. A duplicate Stop - or one that fires with no run in
// progress at all - is treated as already-handled, not as an error to report.
async function sealActiveRun(repoRoot: string): Promise<void> {
	if ((await currentRunId(repoRoot)) !== null) await endRun(repoRoot);
}

export async function runHookCommand(repoRoot: string, stdin: string): Promise<number> {
	try {
		await handleHook(repoRoot, JSON.parse(stdin));
	} catch (error) {
		process.stderr.write(`rpt hook: ${(error as Error).message}\n`);
	}
	return 0;
}

function asStringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}
