import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { RunId } from "../domain/events.js";
import { VERDICT_NAMES, type Verdict } from "../domain/verdict.js";
import { VERIFIER_STATUSES } from "../domain/verifierResult.js";
import { verdictPathOf } from "./paths.js";

// Validated for the same reason approval.json is (src/store/approvals.ts):
// this file is read back and trusted as the sole input to both the critical
// gate and the override-derivation logic in src/app/approveRun.ts, and an
// unchecked cast let a one-line edit naming a different run turn a refused
// critical approval into a recorded one. z.enum against the runtime tuples
// domain declares (VERDICT_NAMES, VERIFIER_STATUSES) rather than a third
// hand-copied list of the same strings.
const verifierResultSchema = z
	.object({
		id: z.string(),
		status: z.enum(VERIFIER_STATUSES),
		reason: z.string().nullable(),
		facts: z.record(z.string(), z.unknown()),
	})
	.strict();

const verdictSchema = z
	.object({
		runId: z.number().int(),
		name: z.enum(VERDICT_NAMES),
		results: z.array(verifierResultSchema),
		decidedAt: z.string().datetime(),
	})
	.strict();

export class InvalidVerdictError extends Error {
	constructor(runId: RunId, detail: string) {
		super(`verdict for run ${runId} is invalid: ${detail}`);
		this.name = "InvalidVerdictError";
	}
}

export async function writeVerdict(rptDir: string, verdict: Verdict): Promise<void> {
	await writeFile(verdictPathOf(rptDir, verdict.runId), `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
}

export async function readVerdict(rptDir: string, runId: RunId): Promise<Verdict | null> {
	const text = await readOrNull(verdictPathOf(rptDir, runId));
	if (text === null) return null;

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new InvalidVerdictError(runId, "not valid JSON");
	}

	const parsed = verdictSchema.safeParse(raw);
	if (!parsed.success) throw new InvalidVerdictError(runId, parsed.error.issues.map((issue) => issue.message).join("; "));

	// Bound to the run it was read for, the same way approval.json is: a
	// verdict recorded under run 1's path but naming run 2 must never be
	// trusted as run 1's own record just because it was found at run 1's path.
	if (parsed.data.runId !== runId) {
		throw new InvalidVerdictError(runId, `the record actually names run ${parsed.data.runId}`);
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
