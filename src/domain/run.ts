import type { ApprovalDecision } from "./approval.js";
import type { AgentEvent, RunId } from "./events.js";
import { transition, type RunState } from "./state.js";
import type { VerdictName } from "./verdict.js";

export type ModelUsage = {
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheCreate: number;
};

export type Claims = { mutatedPaths: string[]; commands: string[] };

export type AgentRun = {
	id: RunId;
	task: string;
	state: RunState;
	baseSha: string | null;
	endSha: string | null;
	startedAt: string;
	endedAt: string | null;
	hasGaps: boolean;
	claims: Claims;
	usage: ModelUsage[];
};

const TASK_MAX_LENGTH = 120;

export function projectRun(id: RunId, events: readonly AgentEvent[]): AgentRun {
	const first = events[0];
	if (first?.kind !== "RunStarted") throw new Error(`run ${id} does not begin with RunStarted`);
	return events.reduce(apply, seedFrom(id, first, events));
}

function seedFrom(id: RunId, started: AgentEvent, events: readonly AgentEvent[]): AgentRun {
	return {
		id,
		task: deriveTask(started, events),
		state: "RUNNING",
		baseSha: asStringOrNull(started.payload.baseSha),
		endSha: null,
		startedAt: started.ts,
		endedAt: null,
		hasGaps: false,
		claims: { mutatedPaths: [], commands: [] },
		usage: [],
	};
}

function deriveTask(started: AgentEvent, events: readonly AgentEvent[]): string {
	const seeded = asNonEmptyString(started.payload.task);
	if (seeded !== null) return seeded;

	const firstPrompt = events.find((event) => event.kind === "PromptSubmitted");
	return firstPrompt ? taskFromPrompt(firstPrompt.payload.prompt) : "";
}

function taskFromPrompt(promptValue: unknown): string {
	if (typeof promptValue !== "string") return "";
	const firstNonEmptyLine = promptValue
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	return (firstNonEmptyLine ?? "").slice(0, TASK_MAX_LENGTH);
}

function apply(run: AgentRun, event: AgentEvent): AgentRun {
	switch (event.kind) {
		case "RunStarted":
			return run;
		case "FileMutated":
			return { ...run, claims: withPath(run.claims, String(event.payload.path ?? "")) };
		case "CommandStarted":
			return { ...run, claims: withCommand(run.claims, String(event.payload.command ?? "")) };
		case "ModelUsageRecorded":
			return { ...run, usage: [...run.usage, readUsage(event.payload)] };
		case "GapRecorded":
			return { ...run, hasGaps: true };
		case "VerificationStarted":
			return { ...run, state: transition(run.state, "VERIFYING") };
		case "VerifierCompleted":
			return run;
		case "AgentStopped":
			return {
				...run,
				state: transition(run.state, "ENDED"),
				endedAt: event.ts,
				endSha: asStringOrNull(event.payload.endSha),
			};
		case "ApprovalGranted":
			return applyApprovalEvent(run, event.payload, "approved");
		case "ApprovalDenied":
			return applyApprovalEvent(run, event.payload, "rejected");
		default:
			return run;
	}
}

// A duplicate or malformed approval event must not make the run permanently
// unloadable: before this, an illegal transition (a second approval event,
// or one naming a verdict this run's history disagrees with) threw straight
// out of the fold, so the one place a decision is recorded became the
// cheapest possible denial of service against itself - a single bad or
// replayed event, and the run could never be loaded, statused or decided
// again. Folding such an event into hasGaps instead - the same treatment a
// torn or unparseable line already gets in eventLog.ts - keeps the run's
// last legitimate state visible and flags the anomaly rather than hiding it
// behind a crash. src/app/approveRun.ts's own precondition check still calls
// applyApprovalDecision directly and still throws: that call is validating a
// fresh, live request, not tolerantly folding a log that may already contain
// imperfect history, and the two have different correct answers to "what do
// I do with an illegal transition" for exactly that reason.
function applyApprovalEvent(run: AgentRun, payload: Record<string, unknown>, decision: ApprovalDecision): AgentRun {
	const verdictName = verdictNameOfSafe(payload);
	if (verdictName === null) return { ...run, hasGaps: true };
	try {
		return { ...run, state: applyApprovalDecision(run.state, verdictName, decision) };
	} catch {
		return { ...run, hasGaps: true };
	}
}

// Shared with src/app/approveRun.ts, which calls this directly to decide
// whether a fresh approval is even legal before it writes anything, and by
// the reducer above, which replays that same edge when folding the event
// log. An approval or rejection only ever legitimately follows a verdict, by
// way of AWAITING_APPROVAL, so this walks that two-edge chain once rather
// than each caller re-deriving it - and, being routed through transition(),
// it throws for a run that is not eligible: never verified, already decided
// (even with the same outcome), or already recorded. That is what makes the
// projection recoverable: rebuilding the index by replaying the event log
// reaches the same approved or rejected state the cache was told directly,
// instead of silently losing it.
export function applyApprovalDecision(state: RunState, verdictName: VerdictName, decision: ApprovalDecision): RunState {
	const verified = transition(state, verdictName);
	const awaiting = transition(verified, "AWAITING_APPROVAL");
	return transition(awaiting, decision === "approved" ? "APPROVED" : "REJECTED");
}

function verdictNameOfSafe(payload: Record<string, unknown>): VerdictName | null {
	const value = payload.verdictName;
	return value === "VERIFIED" || value === "FAILED" || value === "UNVERIFIED" ? value : null;
}

function withPath(claims: Claims, path: string): Claims {
	if (path === "" || claims.mutatedPaths.includes(path)) return claims;
	return { ...claims, mutatedPaths: [...claims.mutatedPaths, path] };
}

function withCommand(claims: Claims, command: string): Claims {
	if (command === "") return claims;
	return { ...claims, commands: [...claims.commands, command] };
}

function readUsage(payload: Record<string, unknown>): ModelUsage {
	return {
		model: String(payload.model ?? "unknown"),
		input: Number(payload.input ?? 0),
		output: Number(payload.output ?? 0),
		cacheRead: Number(payload.cacheRead ?? 0),
		cacheCreate: Number(payload.cacheCreate ?? 0),
	};
}

function asStringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}
