import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import { APPROVAL_DECISIONS, isValidApproverName, type Approval } from "../domain/approval.js";
import type { RunId } from "../domain/events.js";
import { RISK_LEVELS } from "../domain/policy.js";
import { approvalPathOf } from "./paths.js";

// Validated as untrusted data for the same reason runIndex.ts's entrySchema
// is: hand-edited or partially-written JSON is valid far more often than it
// is a valid approval record, and this file sits beside verdict.json as the
// input a later task's commit gate trusts. z.enum against the same runtime
// tuples domain declares (APPROVAL_DECISIONS, RISK_LEVELS) means there is one
// list of valid values, not a second one copied here that could drift.
const approvalSchema = z
	.object({
		runId: z.number().int(),
		decision: z.enum(APPROVAL_DECISIONS),
		by: z.string().refine(isValidApproverName, { message: "approver name is empty, too long, or contains a disallowed character" }),
		// A bare z.string() accepted anything, including a literal newline - the
		// neighbouring field to the approver name allowlist above, and the same
		// injection risk into the git note this record eventually feeds.
		at: z.string().datetime(),
		override: z.boolean(),
		level: z.enum(RISK_LEVELS),
	})
	.strict();

export class InvalidApprovalError extends Error {
	constructor(runId: RunId, detail: string) {
		super(`approval record for run ${runId} is invalid: ${detail}`);
		this.name = "InvalidApprovalError";
	}
}

// Written via a temporary file and a rename rather than a direct write, so a
// crash mid-write never leaves a torn or half-written approval.json for
// readApproval to trip over - the file either does not exist yet or exists
// complete. rename() is atomic on the same filesystem, which the temp file
// (created alongside the real path) guarantees it is on.
export async function writeApproval(rptDir: string, approval: Approval): Promise<void> {
	const path = approvalPathOf(rptDir, approval.runId);
	const tmpPath = `${path}.tmp-${randomUUID()}`;
	await writeFile(tmpPath, `${JSON.stringify(approval, null, 2)}\n`, "utf8");
	await rename(tmpPath, path);
}

export async function readApproval(rptDir: string, runId: RunId): Promise<Approval | null> {
	const text = await readOrNull(approvalPathOf(rptDir, runId));
	if (text === null) return null;

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new InvalidApprovalError(runId, "not valid JSON");
	}

	const parsed = approvalSchema.safeParse(raw);
	if (!parsed.success) throw new InvalidApprovalError(runId, parsed.error.issues.map((issue) => issue.message).join("; "));

	// The file lives at a path already scoped to this run id, but the content
	// is still untrusted - a copy-pasted or hand-edited record could name a
	// different run entirely. Trusting the content over the path it was found
	// at is exactly the kind of unchecked-cast mistake this schema exists to
	// close; refusing here instead keeps the two bound together.
	if (parsed.data.runId !== runId) {
		throw new InvalidApprovalError(runId, `the record actually names run ${parsed.data.runId}`);
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
