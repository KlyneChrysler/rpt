// The only module in rpt that knows the shape of a Claude Code hook payload.
// Field names below are taken from test/fixtures/hooks (captured from a real
// session, Claude Code 2.1.266) - see that directory's README before changing
// any of them.

import type { DraftEvent, EventKind } from "../domain/events.js";
import type { AgentAdapter } from "./AgentAdapter.js";
import { installHooks, uninstallHooks } from "./claudeCodeHooks.js";
import { readTranscriptUsage } from "./transcript.js";

// Known-safe response fields per write tool, taken from the captured fixtures
// (test/fixtures/hooks/PostToolUse.{Write,Edit,NotebookEdit}.json). An
// allowlist, not a denylist: field naming is inconsistent between tools
// (camelCase for Write/Edit, snake_case for NotebookEdit), and a denylist
// written against one tool's response silently lets every field of another
// tool through - including originalFile/newString/oldString on Edit and
// original_file/updated_file/old_source/new_source on NotebookEdit, all of
// which hold whole file or notebook contents. MultiEdit has no entry because
// it does not exist in the captured build (test/fixtures/hooks/README.md);
// a build where it does exist will fall through to the keys-only summary
// below rather than being guessed at.
const WRITE_TOOL_RESPONSE_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
	Write: ["filePath", "type", "userModified"],
	Edit: ["filePath", "replaceAll", "userModified"],
	NotebookEdit: ["notebook_path", "cell_id", "cell_type", "edit_mode", "language", "error"],
};

const WRITE_TOOLS = new Set(Object.keys(WRITE_TOOL_RESPONSE_ALLOWLIST));

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
	} catch (error) {
		// Malformed input must never crash the hook process: a lost event is
		// recoverable, a crashed `claude` invocation is not. But silence here
		// would be a landmine for the next refactor that introduces a throwing
		// path, so the failure is traced to stderr before the event is dropped.
		process.stderr.write(
			`rpt: claude-code adapter: normalization failed for hook_event_name=${recoverHookEventName(raw)}: ${errorMessage(error)}\n`,
		);
		return [];
	}
}

function recoverHookEventName(raw: unknown): string {
	try {
		if (isPlainObject(raw) && typeof raw.hook_event_name === "string") return raw.hook_event_name;
	} catch {
		// Reading the field itself threw (e.g. a getter on a malformed object).
	}
	return "unknown";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
	if (tool === "Bash") return bashOutputSummary(response);
	const allowlist = WRITE_TOOL_RESPONSE_ALLOWLIST[tool];
	if (allowlist) return writeResponseSummary(response, allowlist);
	return { completed: true, responseKeys: Object.keys(response).sort() };
}

function bashOutputSummary(response: Record<string, unknown>): Record<string, unknown> {
	return {
		stdout: truncate(response.stdout),
		stderr: truncate(response.stderr),
		interrupted: response.interrupted === true,
	};
}

function writeResponseSummary(response: Record<string, unknown>, allowlist: readonly string[]): Record<string, unknown> {
	const summary: Record<string, unknown> = {};
	for (const key of allowlist) {
		if (!(key in response)) continue;
		const value = response[key];
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
	const body: Record<string, unknown> = { command: asString(input.command), ...bashOutputSummary(response) };
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
