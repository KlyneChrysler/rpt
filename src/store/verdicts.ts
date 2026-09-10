import { readFile, writeFile } from "node:fs/promises";
import type { RunId } from "../domain/events.js";
import type { Verdict } from "../domain/verdict.js";
import { verdictPathOf } from "./paths.js";

// verdict.json lives under .rpt, so - same rule as index.jsonl, events.jsonl
// and pricing.json - only this layer may write it.
export async function writeVerdict(rptDir: string, verdict: Verdict): Promise<void> {
	await writeFile(verdictPathOf(rptDir, verdict.runId), `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
}

export async function readVerdict(rptDir: string, runId: RunId): Promise<Verdict | null> {
	try {
		return JSON.parse(await readFile(verdictPathOf(rptDir, runId), "utf8")) as Verdict;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
