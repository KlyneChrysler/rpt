export type RunId = number;

export type EventKind =
	| "RunStarted"
	| "AgentStopped"
	| "RunCommitted"
	| "PromptSubmitted"
	| "ToolCallStarted"
	| "ToolCallCompleted"
	| "FileMutated"
	| "CommandStarted"
	| "CommandCompleted"
	| "ModelUsageRecorded"
	| "VerificationStarted"
	| "VerifierCompleted"
	| "RiskAssessed"
	| "ApprovalRequested"
	| "ApprovalGranted"
	| "ApprovalDenied"
	| "GapRecorded";

export type EventSource = "claude-code" | "rpt";

export type DraftEvent = {
	ts: string;
	source: EventSource;
	kind: EventKind;
	payload: Record<string, unknown>;
};

export type AgentEvent = DraftEvent & { runId: RunId; seq: number };

export type StoredEvent = AgentEvent & { checksum: string };
