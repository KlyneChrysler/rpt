import type { RunId } from "./events.js";
import type { VerifierResult } from "./verifierResult.js";

export type VerdictName = "VERIFIED" | "FAILED" | "UNVERIFIED";

export type Verdict = {
	runId: RunId;
	name: VerdictName;
	results: VerifierResult[];
	decidedAt: string;
};

// Unverified is not a softer failure than failed - it means rpt does not know,
// and this project treats not knowing as blocking rather than passing. A
// failure anywhere wins outright; short of that, any skip (an unrunnable
// check) or a gapped event log means the record is incomplete and the run
// cannot be called verified, even if everything that did run passed.
export function decideVerdict(results: readonly VerifierResult[], hasGaps: boolean): VerdictName {
	if (results.some((result) => result.status === "failed")) return "FAILED";
	if (hasGaps || results.length === 0) return "UNVERIFIED";
	if (results.some((result) => result.status === "skipped")) return "UNVERIFIED";
	return "VERIFIED";
}
