import { claudeCodeAdapter } from "../collectors/claudeCode.js";
import { createSnapshot } from "../git/snapshot.js";
import type { DraftEvent, RunId } from "../domain/events.js";
import type { AgentRun } from "../domain/run.js";
import { appendEvent, readEvents } from "../store/eventLog.js";
import { transitionCurrentRun } from "../store/currentRun.js";
import { rptDirOf } from "../store/paths.js";
import { upsertRun } from "../store/runIndex.js";
import { loadRun } from "./loadRun.js";

export class NoRunInProgressError extends Error {
	constructor() {
		super("no run in progress for this repository");
		this.name = "NoRunInProgressError";
	}
}

export async function endRun(repoRoot: string): Promise<AgentRun> {
	const rptDir = rptDirOf(repoRoot);
	// The whole check-snapshot-append-upsert sequence runs inside transitionCurrentRun's
	// lock, not just the pointer's own read and write: that is what makes sealing
	// exactly-once even when two Stop hooks (or a Stop racing a stale-run seal from a
	// SessionStart) fire concurrently for the same run. The second caller's `current`
	// read happens only after the first has fully finished and cleared the pointer, so
	// it sees null and throws instead of re-sealing the same run.
	return transitionCurrentRun(rptDir, async (current) => {
		if (current === null) throw new NoRunInProgressError();
		const runId = current;
		const endSha = await createSnapshot(repoRoot, runId, "end");
		const endedAt = new Date().toISOString();

		// Enriched *before* AgentStopped is appended, and before anything else in
		// this callback has written. usageDrafts() never throws (a transcript
		// problem degrades to no usage events - a run that cannot be priced is
		// still a valid run), but if it ever did, sealing before that point would
		// leave the run stopped in the log but not ended in the index: stranded,
		// with a retry appending a second AgentStopped. Computing it first means a
		// failure here aborts before any of that has been written.
		const usage = await usageDrafts(rptDir, repoRoot, runId);

		await appendEvent(rptDir, runId, {
			ts: endedAt,
			source: "rpt",
			kind: "AgentStopped",
			payload: { endSha },
		});
		for (const draft of usage) {
			await appendEvent(rptDir, runId, draft);
		}
		// Reload through the fold rather than trust the draft that started the run: a
		// SessionStart carries no task, so the index row written at start time is blank
		// (controller ruling). By now the first PromptSubmitted may have arrived, and
		// projectRun derives the task from it - this is where that derived task reaches
		// the index, self-healing the row instead of leaving it permanently blank.
		const run = await loadRun(repoRoot, runId);
		await upsertRun(rptDir, { id: runId, task: run.task, state: "ENDED", startedAt: run.startedAt, endedAt });
		return { next: null, result: run };
	});
}

// Reads the run's transcript path from its RunStarted event and enriches with
// model usage from that transcript, if there is one. Never throws: a
// transcript that is unreadable for any reason (not just missing - a
// permissions error, a directory where a file was expected, ...) must not
// block the run from sealing, so any failure here is traced to stderr and
// treated the same as "no transcript".
async function usageDrafts(rptDir: string, repoRoot: string, runId: RunId): Promise<DraftEvent[]> {
	try {
		const started = (await readEvents(rptDir, runId)).events.find((event) => event.kind === "RunStarted");
		const transcriptPath = typeof started?.payload.transcriptPath === "string" ? started.payload.transcriptPath : null;
		return await claudeCodeAdapter.enrich(await loadRun(repoRoot, runId), { transcriptPath });
	} catch (error) {
		process.stderr.write(`rpt: transcript enrichment failed for run ${runId}, sealing without usage: ${errorMessage(error)}\n`);
		return [];
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
