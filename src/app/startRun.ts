import { createSnapshot, headSha } from "../git/snapshot.js";
import type { AgentRun } from "../domain/run.js";
import { appendEvent } from "../store/eventLog.js";
import { transitionCurrentRun } from "../store/currentRun.js";
import { rptDirOf } from "../store/paths.js";
import { allocateRunId, upsertRun } from "../store/runIndex.js";
import { loadRun } from "./loadRun.js";

export type StartRunInput = { task: string; transcriptPath: string | null };

export async function startRun(repoRoot: string, input: StartRunInput): Promise<AgentRun> {
	const rptDir = rptDirOf(repoRoot);
	// No separate mkdir needed here: transitionCurrentRun creates .rpt via its own
	// preparedPointer before this callback ever runs, and allocateRunId prepares it
	// again defensively (see runIndex.ts's preparedIndex) - both idempotent.
	const runId = await transitionCurrentRun(rptDir, async () => {
		const id = await allocateRunId(rptDir);
		const baseSha = await createSnapshot(repoRoot, id, "base");
		const startedAt = new Date().toISOString();
		await appendEvent(rptDir, id, {
			ts: startedAt,
			source: "rpt",
			kind: "RunStarted",
			payload: { task: input.task, baseSha, headSha: await headSha(repoRoot), transcriptPath: input.transcriptPath },
		});
		await upsertRun(rptDir, { id, task: input.task, state: "RUNNING", startedAt, endedAt: null });
		return { next: id, result: id };
	});
	return loadRun(repoRoot, runId);
}
