import type { DraftEvent } from "../domain/events.js";
import { deliverOrRecordGap } from "../daemon/client.js";
import { readCurrentRunId } from "../store/currentRun.js";
import { rptDirOf } from "../store/paths.js";

export async function recordEvent(repoRoot: string, draft: DraftEvent): Promise<void> {
	const rptDir = rptDirOf(repoRoot);
	const runId = await readCurrentRunId(rptDir);
	if (runId === null) return;
	await deliverOrRecordGap(rptDir, runId, draft);
}
