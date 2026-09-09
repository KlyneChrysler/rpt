import { claudeCodeAdapter } from "../collectors/claudeCode.js";
import { createSnapshot } from "../git/snapshot.js";
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
		await appendEvent(rptDir, runId, {
			ts: endedAt,
			source: "rpt",
			kind: "AgentStopped",
			payload: { endSha },
		});
		// Enrich with model usage from the transcript, if the run started with one.
		// This reads the transcript file (at most once) while still inside
		// transitionCurrentRun's lock - acceptable because the read is local and
		// bounded, not a network call, so it does not meaningfully extend how long
		// the pointer stays locked.
		const started = (await readEvents(rptDir, runId)).events.find((event) => event.kind === "RunStarted");
		const transcriptPath = typeof started?.payload.transcriptPath === "string" ? started.payload.transcriptPath : null;
		for (const draft of await claudeCodeAdapter.enrich(await loadRun(repoRoot, runId), { transcriptPath })) {
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
