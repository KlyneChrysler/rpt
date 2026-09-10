import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { configSchema, type RptConfig } from "../config/schema.js";
import type { RunId } from "../domain/events.js";
import { runConfigPathOf } from "./paths.js";

// Written once, at run start, by startRun.ts - before the event log has
// necessarily created the run's directory, so this creates it itself, the
// same way eventLog.ts's own append does. Never rewritten, so no
// atomic-write concern the way approval.json (written repeatedly, including
// on a healing retry) has. Validated with the same configSchema
// rpt.config.json itself is parsed with on every read, since this is the
// same data, just captured at a different moment.
export async function writeRunConfig(rptDir: string, runId: RunId, config: RptConfig): Promise<void> {
	const path = runConfigPathOf(rptDir, runId);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function readRunConfig(rptDir: string, runId: RunId): Promise<RptConfig | null> {
	const text = await readOrNull(runConfigPathOf(rptDir, runId));
	if (text === null) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error(`config snapshot for run ${runId} is not valid JSON`);
	}
	const parsed = configSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(`config snapshot for run ${runId} is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
	}
	return parsed.data;
}

async function readOrNull(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
