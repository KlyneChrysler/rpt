import { createSnapshot } from "../git/snapshot.js";
import type { AgentRun } from "../domain/run.js";
import { appendEvent } from "../store/eventLog.js";
import { rptDirOf } from "../store/paths.js";
import { upsertRun } from "../store/runIndex.js";
import { currentRunId, loadRun, setCurrentRunId } from "./loadRun.js";

export async function endRun(repoRoot: string): Promise<AgentRun> {
	const runId = await currentRunId(repoRoot);
	if (runId === null) throw new Error("no run in progress for this repository");
	const rptDir = rptDirOf(repoRoot);
	const endSha = await createSnapshot(repoRoot, runId, "end");
	const endedAt = new Date().toISOString();
	await appendEvent(rptDir, runId, {
		ts: endedAt,
		source: "rpt",
		kind: "AgentStopped",
		payload: { endSha },
	});
	// Reload through the fold rather than trust the draft that started the run: a
	// SessionStart carries no task, so the index row written at start time is blank
	// (controller ruling). By now the first PromptSubmitted may have arrived, and
	// projectRun derives the task from it - this is where that derived task reaches
	// the index, self-healing the row instead of leaving it permanently blank.
	const run = await loadRun(repoRoot, runId);
	await upsertRun(rptDir, { id: runId, task: run.task, state: "ENDED", startedAt: run.startedAt, endedAt });
	await setCurrentRunId(repoRoot, null);
	return run;
}
