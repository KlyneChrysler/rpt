import type { AgentEvent, RunId } from "./events.js";
import { transition, type RunState } from "./state.js";

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
		case "AgentStopped":
			return {
				...run,
				state: transition(run.state, "ENDED"),
				endedAt: event.ts,
				endSha: asStringOrNull(event.payload.endSha),
			};
		default:
			return run;
	}
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
