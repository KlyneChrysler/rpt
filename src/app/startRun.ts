import { loadConfig } from "../config/load.js";
import { fingerprintOf } from "../domain/checksum.js";
import { createSnapshot, headSha } from "../git/snapshot.js";
import type { AgentRun } from "../domain/run.js";
import { appendEvent } from "../store/eventLog.js";
import { transitionCurrentRun } from "../store/currentRun.js";
import { rptDirOf } from "../store/paths.js";
import { allocateRunId, upsertRun } from "../store/runIndex.js";
import { writeRunConfig } from "../store/runConfig.js";
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
		// Snapshotted before the run has done anything at all, so the config
		// this run is later judged against cannot itself be something this
		// run's own edits produced. The fingerprint is recorded in RunStarted
		// itself, not only alongside the snapshot file, so a later reader can
		// tell a missing or altered snapshot apart from a run that genuinely
		// predates this feature - both otherwise present identically as "no
		// snapshot to read" (see src/app/loadRunConfig.ts).
		const configSnapshot = await loadConfig(repoRoot);
		await writeRunConfig(rptDir, id, configSnapshot);
		await appendEvent(rptDir, id, {
			ts: startedAt,
			source: "rpt",
			kind: "RunStarted",
			payload: {
				task: input.task,
				baseSha,
				headSha: await headSha(repoRoot),
				transcriptPath: input.transcriptPath,
				configFingerprint: fingerprintOf(configSnapshot),
			},
		});
		await upsertRun(rptDir, { id, task: input.task, state: "RUNNING", startedAt, endedAt: null });
		return { next: id, result: id };
	});
	return loadRun(repoRoot, runId);
}
