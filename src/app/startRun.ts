import { mkdir } from "node:fs/promises";
import { createSnapshot, headSha } from "../git/snapshot.js";
import type { AgentRun } from "../domain/run.js";
import { appendEvent } from "../store/eventLog.js";
import { rptDirOf } from "../store/paths.js";
import { allocateRunId, upsertRun } from "../store/runIndex.js";
import { loadRun, setCurrentRunId } from "./loadRun.js";

export type StartRunInput = { task: string; transcriptPath: string | null };

export async function startRun(repoRoot: string, input: StartRunInput): Promise<AgentRun> {
	const rptDir = rptDirOf(repoRoot);
	await mkdir(rptDir, { recursive: true });
	const runId = await allocateRunId(rptDir);
	const baseSha = await createSnapshot(repoRoot, runId, "base");
	const startedAt = new Date().toISOString();
	await appendEvent(rptDir, runId, {
		ts: startedAt,
		source: "rpt",
		kind: "RunStarted",
		payload: { task: input.task, baseSha, headSha: await headSha(repoRoot), transcriptPath: input.transcriptPath },
	});
	await upsertRun(rptDir, { id: runId, task: input.task, state: "RUNNING", startedAt, endedAt: null });
	await setCurrentRunId(repoRoot, runId);
	return loadRun(repoRoot, runId);
}
