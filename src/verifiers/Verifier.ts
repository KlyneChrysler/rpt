import type { RptConfig } from "../config/schema.js";
import type { Claims } from "../domain/run.js";

export type VerifierStatus = "passed" | "failed" | "skipped";

export type VerifierResult = {
	id: string;
	status: VerifierStatus;
	reason: string | null;
	facts: Record<string, unknown>;
};

export type RunContext = {
	repoRoot: string;
	worktree: string;
	baseSha: string;
	endSha: string;
	config: RptConfig;
	claims: Claims;
};

export interface Verifier {
	readonly id: string;
	run(context: RunContext): Promise<VerifierResult>;
}

export async function runVerifiers(
	verifiers: readonly Verifier[],
	context: RunContext,
): Promise<VerifierResult[]> {
	const results: VerifierResult[] = [];
	for (const verifier of verifiers) results.push(await runOne(verifier, context));
	return results;
}

async function runOne(verifier: Verifier, context: RunContext): Promise<VerifierResult> {
	let result: VerifierResult;
	try {
		result = await verifier.run(context);
	} catch (error) {
		let message: string;
		try {
			message = normalizeThrownValue(error);
		} catch {
			message = "failed to describe thrown value";
		}
		return skipped(verifier.id, `verifier threw: ${message}`);
	}

	let resultId: string;
	try {
		resultId = result.id;
	} catch {
		resultId = "[id getter threw]";
	}

	try {
		return assertExplained(result);
	} catch (error) {
		return skipped(verifier.id, `verifier ${resultId} violated contract: ${(error as Error).message}`);
	}
}

function normalizeThrownValue(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return String(error);
}

function assertExplained(result: VerifierResult): VerifierResult {
	if (result.status !== "passed") {
		if (result.reason === null || (typeof result.reason === "string" && result.reason.trim() === "")) {
			throw new Error(`returned ${result.status} without a reason`);
		}
	}
	return result;
}

export function skipped(id: string, reason: string): VerifierResult {
	return { id, status: "skipped", reason, facts: {} };
}

export function passed(id: string, facts: Record<string, unknown> = {}): VerifierResult {
	return { id, status: "passed", reason: null, facts };
}

export function failed(id: string, reason: string, facts: Record<string, unknown> = {}): VerifierResult {
	return { id, status: "failed", reason, facts };
}
