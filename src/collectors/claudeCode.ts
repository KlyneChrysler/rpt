// The only module in rpt that knows the shape of a Claude Code hook payload.
// Field names below are taken from test/fixtures/hooks (captured from a real
// session, Claude Code 2.1.266) - see that directory's README before changing
// any of them.

import type { DraftEvent, EventKind } from "../domain/events.js";
import type { AgentAdapter } from "./AgentAdapter.js";
import { installHooks, uninstallHooks } from "./claudeCodeHooks.js";
import { readTranscriptUsage } from "./transcript.js";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// Fields on a write-tool's tool_response that hold file content or a diff of
// it. rpt already captures the real content via git snapshots; storing it a
// second time in the event log would duplicate that and bloat every edit.
const CONTENT_BEARING_RESPONSE_FIELDS = new Set([
	"content",
	"originalFile",
	"newContent",
	"oldContent",
	"structuredPatch",
	"patch",
	"diff",
]);

// Modest bound on how much of a Bash tool's stdout/stderr is kept per event.
// Chosen to keep typical command output (a few dozen lines) intact while
// capping the pathological case (a build log, a huge file dump) well short
// of bloating the append-only log.
const MAX_CAPTURED_OUTPUT_CHARS = 4000;
const TRUNCATION_SUFFIX = "…[truncated]";

export const claudeCodeAdapter: AgentAdapter = {
	id: "claude-code",
	install: installHooks,
	uninstall: uninstallHooks,
	normalize,
	async enrich(_run, context) {
		if (context.transcriptPath === null) return [];
		return readTranscriptUsage(context.transcriptPath);
	},
};

export function normalize(raw: unknown): DraftEvent[] {
	try {
		return dispatch(raw);
	} catch {
		// Malformed input must never crash the hook process: a lost event is
		// recoverable, a crashed `claude` invocation is not.
		return [];
	}
}

function dispatch(raw: unknown): DraftEvent[] {
	if (!isPlainObject(raw)) return [];
	const payload = raw;
	switch (String(payload.hook_event_name ?? "")) {
		case "SessionStart":
			return [event("RunStarted", runStartedPayload(payload))];
		case "UserPromptSubmit":
			return [event("PromptSubmitted", { prompt: asString(payload.prompt) })];
		case "PreToolUse":
			return [event("ToolCallStarted", toolCallStartedPayload(payload))];
		case "PostToolUse":
			return postToolUse(payload);
		case "Stop":
			return [event("AgentStopped", {})];
		default:
			return [];
	}
}

function runStartedPayload(payload: Record<string, unknown>): Record<string, unknown> {
	// Ruling D: the captured SessionStart payload has no task field of any
	// kind, so none is invented here. projectRun derives the task from the
	// first PromptSubmitted event instead.
	return {
		transcriptPath: asStringOrNull(payload.transcript_path),
		cwd: asStringOrNull(payload.cwd),
	};
}

function toolCallStartedPayload(payload: Record<string, unknown>): Record<string, unknown> {
	return {
		tool: asString(payload.tool_name),
		input: isPlainObject(payload.tool_input) ? payload.tool_input : {},
		// Ruling F: carried so a timeline can pair this start with its completion.
		toolUseId: asStringOrNull(payload.tool_use_id),
	};
}

function postToolUse(payload: Record<string, unknown>): DraftEvent[] {
	const tool = asString(payload.tool_name);
	const completed = event("ToolCallCompleted", toolCallCompletedPayload(payload, tool));

	if (WRITE_TOOLS.has(tool)) return [completed, ...mutations(payload)];
	if (tool === "Bash") return [completed, event("CommandCompleted", commandCompletedPayload(payload))];
	return [completed];
}

function toolCallCompletedPayload(payload: Record<string, unknown>, tool: string): Record<string, unknown> {
	const body: Record<string, unknown> = {
		tool,
		toolUseId: asStringOrNull(payload.tool_use_id),
		response: summarizeToolResponse(tool, payload.tool_response),
	};
	const durationMs = asFiniteNumber(payload.duration_ms);
	if (durationMs !== null) body.durationMs = durationMs;
	return body;
}

// Ruling E: store a small selected summary of tool_response per tool kind,
// never the whole object.
function summarizeToolResponse(tool: string, rawResponse: unknown): Record<string, unknown> {
	const response = isPlainObject(rawResponse) ? rawResponse : {};
	if (tool === "Bash") return bashResponseSummary(response);
	if (WRITE_TOOLS.has(tool)) return writeResponseSummary(response);
	return { completed: true, responseKeys: Object.keys(response).sort() };
}

function bashResponseSummary(response: Record<string, unknown>): Record<string, unknown> {
	return {
		stdout: truncate(response.stdout),
		stderr: truncate(response.stderr),
		interrupted: response.interrupted === true,
	};
}

function writeResponseSummary(response: Record<string, unknown>): Record<string, unknown> {
	const summary: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(response)) {
		if (CONTENT_BEARING_RESPONSE_FIELDS.has(key)) continue;
		if (isJsonScalar(value)) summary[key] = value;
	}
	return summary;
}

function mutations(payload: Record<string, unknown>): DraftEvent[] {
	const input = isPlainObject(payload.tool_input) ? payload.tool_input : {};
	const path = input.file_path ?? input.notebook_path;
	if (typeof path !== "string") return [];
	return [event("FileMutated", { path, operation: "write" })];
}

function commandCompletedPayload(payload: Record<string, unknown>): Record<string, unknown> {
	const input = isPlainObject(payload.tool_input) ? payload.tool_input : {};
	const response = isPlainObject(payload.tool_response) ? payload.tool_response : {};
	const body: Record<string, unknown> = {
		command: asString(input.command),
		stdout: truncate(response.stdout),
		stderr: truncate(response.stderr),
		interrupted: response.interrupted === true,
	};
	const durationMs = asFiniteNumber(payload.duration_ms);
	if (durationMs !== null) body.durationMs = durationMs;
	return body;
}

function truncate(value: unknown): string {
	const text = typeof value === "string" ? value : "";
	return text.length > MAX_CAPTURED_OUTPUT_CHARS
		? text.slice(0, MAX_CAPTURED_OUTPUT_CHARS) + TRUNCATION_SUFFIX
		: text;
}

function event(kind: EventKind, payload: Record<string, unknown>): DraftEvent {
	return { ts: new Date().toISOString(), source: "claude-code", kind, payload };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonScalar(value: unknown): value is string | number | boolean | null {
	if (value === null) return true;
	if (typeof value === "string" || typeof value === "boolean") return true;
	return typeof value === "number" && Number.isFinite(value);
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asStringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
