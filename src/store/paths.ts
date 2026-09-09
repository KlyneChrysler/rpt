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

export function currentPointerOf(rptDir: string): string {
	return join(rptDir, "current");
}

export function pricingFileOf(rptDir: string): string {
	return join(rptDir, "pricing.json");
}

// The daemon owns the server; the store owns the file, because the file lives
// under .rpt and nothing outside this layer may decide where anything there goes.
export function socketPathOf(rptDir: string): string {
	return join(rptDir, "daemon.sock");
}
