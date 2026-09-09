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
		return skipped(verifier.id, `verifier threw: ${(error as Error).message}`);
	}
	return assertExplained(result);
}

function assertExplained(result: VerifierResult): VerifierResult {
	if (result.status !== "passed" && result.reason === null) {
		throw new Error(`verifier ${result.id} returned ${result.status} without a reason`);
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
