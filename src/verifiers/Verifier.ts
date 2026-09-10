import type { RptConfig } from "../config/schema.js";
import type { Claims } from "../domain/run.js";
import type { VerifierResult } from "../domain/verifierResult.js";

// The verdict rule in src/domain/verdict.ts owns this type; re-exported here
// so every verifier's existing `from "./Verifier.js"` import keeps working.
export type { VerifierResult, VerifierStatus } from "../domain/verifierResult.js";

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
	// Whether this verifier is enabled at all for the given config. A verifier
	// with no opinion is always enabled, which is every verifier but one.
	enabledFor?(config: RptConfig): boolean;
}

// A verifier a project has turned off is not run and contributes no result,
// rather than contributing a skip. That distinction is the whole point: under
// this project's rule that missing evidence is never a pass, a skip downgrades
// a run to UNVERIFIED forever, so a config option named "off" that emitted one
// meant every run in that repository was permanently unverifiable and every
// commit permanently gated - the opposite of what turning a check off asks for.
// Nothing is hidden by the omission: the verdict lists the checks that ran, and
// the config snapshot it was judged under is fingerprinted and drift-checked,
// so "test-quality is absent because the config disabled it" stays legible and
// stays tamper-evident.
export async function runVerifiers(
	verifiers: readonly Verifier[],
	context: RunContext,
): Promise<VerifierResult[]> {
	const results: VerifierResult[] = [];
	for (const verifier of verifiers) {
		if (verifier.enabledFor?.(context.config) === false) continue;
		results.push(await runOne(verifier, context));
	}
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
