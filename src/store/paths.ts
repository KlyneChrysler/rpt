import { join } from "node:path";
import type { RunId } from "../domain/events.js";

export function rptDirOf(repoRoot: string): string {
	return join(repoRoot, ".rpt");
}

export function runIndexOf(rptDir: string): string {
	return join(rptDir, "index.jsonl");
}

export function runDirOf(rptDir: string, runId: RunId): string {
	return join(rptDir, "runs", String(runId));
}

export function eventLogOf(rptDir: string, runId: RunId): string {
	return join(runDirOf(rptDir, runId), "events.jsonl");
}
