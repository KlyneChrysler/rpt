export type RunState =
	| "RUNNING"
	| "ENDED"
	| "VERIFYING"
	| "VERIFIED"
	| "FAILED"
	| "UNVERIFIED"
	| "AWAITING_APPROVAL"
	| "APPROVED"
	| "REJECTED"
	| "RECORDED";

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
