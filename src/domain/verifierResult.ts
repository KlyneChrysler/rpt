// Owned by domain, not by src/verifiers, because the verdict rule (also
// domain logic) consumes it directly and the purity guard forbids domain
// importing from outside itself. src/verifiers/Verifier.ts re-exports this
// type so every existing verifier import keeps working unchanged.
export type VerifierStatus = "passed" | "failed" | "skipped";

export type VerifierResult = {
	id: string;
	status: VerifierStatus;
	reason: string | null;
	facts: Record<string, unknown>;
};
