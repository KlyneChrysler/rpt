import type { DraftEvent } from "../domain/events.js";
import { deliverOrRecordGap } from "../daemon/client.js";
import { rptDirOf } from "../store/paths.js";
import { currentRunId } from "./loadRun.js";

export async function recordEvent(repoRoot: string, draft: DraftEvent): Promise<void> {
	const runId = await currentRunId(repoRoot);
	if (runId === null) return;
	await deliverOrRecordGap(rptDirOf(repoRoot), runId, draft);
}
