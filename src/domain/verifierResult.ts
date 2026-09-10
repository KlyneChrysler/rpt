// Owned by domain, not by src/verifiers, because the verdict rule (also
// domain logic) consumes it directly and the purity guard forbids domain
// importing from outside itself. src/verifiers/Verifier.ts re-exports this
// type so every existing verifier import keeps working unchanged.
export const VERIFIER_STATUSES = ["passed", "failed", "skipped"] as const;
export type VerifierStatus = (typeof VERIFIER_STATUSES)[number];

export type VerifierResult = {
	id: string;
	status: VerifierStatus;
	reason: string | null;
	facts: Record<string, unknown>;
};
