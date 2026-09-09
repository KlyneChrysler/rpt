// The states exist at runtime, not just in the type system: an index row read
// back from disk is untrusted JSON, and "is this a state rpt knows" is a question
// only a value can answer. Deriving the type from the list keeps the two from
// drifting apart the way a hand-maintained second copy would.
export const RUN_STATES = [
	"RUNNING",
	"ENDED",
	"VERIFYING",
	"VERIFIED",
	"FAILED",
	"UNVERIFIED",
	"AWAITING_APPROVAL",
	"APPROVED",
	"REJECTED",
	"RECORDED",
] as const;

export type RunState = (typeof RUN_STATES)[number];

const ALLOWED: Readonly<Record<RunState, readonly RunState[]>> = {
	RUNNING: ["ENDED"],
	ENDED: ["VERIFYING"],
	VERIFYING: ["VERIFIED", "FAILED", "UNVERIFIED"],
	VERIFIED: ["AWAITING_APPROVAL", "RECORDED"],
	FAILED: ["AWAITING_APPROVAL"],
	UNVERIFIED: ["AWAITING_APPROVAL"],
	AWAITING_APPROVAL: ["APPROVED", "REJECTED"],
	APPROVED: ["RECORDED"],
	REJECTED: [],
	RECORDED: [],
};

export class IllegalTransitionError extends Error {
	constructor(from: RunState, to: RunState) {
		super(`illegal run transition ${from} -> ${to}`);
		this.name = "IllegalTransitionError";
	}
}

export function transition(from: RunState, to: RunState): RunState {
	if (!ALLOWED[from].includes(to)) throw new IllegalTransitionError(from, to);
	return to;
}

export function isTerminal(state: RunState): boolean {
	return ALLOWED[state].length === 0;
}

export function requiresHumanDecision(state: RunState): boolean {
	return state === "FAILED" || state === "UNVERIFIED";
}
