import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunId } from "../domain/events.js";
import { projectRun, type AgentRun } from "../domain/run.js";
import { readEvents } from "../store/eventLog.js";
import { rptDirOf } from "../store/paths.js";

export async function loadRun(repoRoot: string, runId: RunId): Promise<AgentRun> {
	const { events, gapCount } = await readEvents(rptDirOf(repoRoot), runId);
	const run = projectRun(runId, events);
	return gapCount > 0 ? { ...run, hasGaps: true } : run;
}

export async function currentRunId(repoRoot: string): Promise<RunId | null> {
	try {
		const raw = (await readFile(join(rptDirOf(repoRoot), "current"), "utf8")).trim();
		// A cleared pointer is written as "" by setCurrentRunId(repoRoot, null); Number("")
		// is 0, which Number.isInteger accepts, so without this check a cleared pointer
		// would silently read back as run 0 instead of "no run in progress".
		if (raw === "") return null;
		const id = Number(raw);
		return Number.isInteger(id) ? id : null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export async function setCurrentRunId(repoRoot: string, runId: RunId | null): Promise<void> {
	const path = join(rptDirOf(repoRoot), "current");
	await writeFile(path, runId === null ? "" : String(runId), "utf8");
}
