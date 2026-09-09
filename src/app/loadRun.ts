import type { RunId } from "../domain/events.js";
import { projectRun, type AgentRun } from "../domain/run.js";
import { readEvents } from "../store/eventLog.js";
import { rptDirOf } from "../store/paths.js";

export async function loadRun(repoRoot: string, runId: RunId): Promise<AgentRun> {
	const { events, gapCount } = await readEvents(rptDirOf(repoRoot), runId);
	const run = projectRun(runId, events);
	return gapCount > 0 ? { ...run, hasGaps: true } : run;
}
