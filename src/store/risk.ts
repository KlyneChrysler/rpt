import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { RunId } from "../domain/events.js";
import { RISK_LEVELS } from "../domain/policy.js";
import { VERDICT_NAMES, type VerdictName } from "../domain/verdict.js";
import type { RiskAssessment } from "../risk/assess.js";
import { riskPathOf, runDirOf } from "./paths.js";

// The assessment a run was actually judged by, with everything needed to tell
// whether it still describes that run: which verdict it was computed from and
// the fingerprint of the config it was computed under. Risk scoring is a pure
// function of facts already in the record, so this file is a readable copy of a
// derivable value, not a second source of truth - and a copy that cannot say
// what it was derived from is exactly the copy that goes stale in silence.
export type RecordedRiskAssessment = RiskAssessment & {
	runId: RunId;
	verdictName: VerdictName;
	configFingerprint: string;
	assessedAt: string;
};

const contributionSchema = z.object({ id: z.string(), label: z.string(), points: z.number() }).strict();

const recordedRiskSchema = z
	.object({
		runId: z.number().int(),
		score: z.number().min(0).max(100),
		level: z.enum(RISK_LEVELS),
		contributions: z.array(contributionSchema),
		verdictName: z.enum(VERDICT_NAMES),
		configFingerprint: z.string(),
		assessedAt: z.string().datetime(),
	})
	.strict();

export class InvalidRiskRecordError extends Error {
	constructor(runId: RunId, detail: string) {
		super(`risk record for run ${runId} is invalid: ${detail}`);
		this.name = "InvalidRiskRecordError";
	}
}

export async function writeRiskAssessment(rptDir: string, assessment: RecordedRiskAssessment): Promise<void> {
	await mkdir(runDirOf(rptDir, assessment.runId), { recursive: true });
	await writeFile(riskPathOf(rptDir, assessment.runId), `${JSON.stringify(assessment, null, 2)}\n`, "utf8");
}

// Never an input to a gate or an approval: those recompute from the verdict and
// the config snapshot on every call, on purpose, so a hand-edited risk.json
// cannot lower a level anybody is judged at. This read exists so a person, a
// listing or another tool can see what a run scored without re-running the
// engine. It is still schema-validated and bound to the run whose path it was
// found at, because a record that can be read is a record that can be edited.
export async function readRiskAssessment(rptDir: string, runId: RunId): Promise<RecordedRiskAssessment | null> {
	const text = await readOrNull(riskPathOf(rptDir, runId));
	if (text === null) return null;

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new InvalidRiskRecordError(runId, "not valid JSON");
	}

	const parsed = recordedRiskSchema.safeParse(raw);
	if (!parsed.success) throw new InvalidRiskRecordError(runId, parsed.error.issues.map((issue) => issue.message).join("; "));
	if (parsed.data.runId !== runId) {
		throw new InvalidRiskRecordError(runId, `the record actually names run ${parsed.data.runId}`);
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
