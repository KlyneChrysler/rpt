import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checksumOf } from "../../src/domain/checksum.js";
import type { AgentEvent } from "../../src/domain/events.js";
import { claudeCodeAdapter, normalize } from "../../src/collectors/claudeCode.js";

async function fixture(name: string): Promise<unknown> {
	return JSON.parse(await readFile(join("test/fixtures/hooks", `${name}.json`), "utf8"));
}

describe("claudeCodeAdapter.normalize", () => {
	it("turns SessionStart into RunStarted carrying the transcript path and cwd, with no task field", async () => {
		const [event] = normalize(await fixture("SessionStart"));
		expect(event?.kind).toBe("RunStarted");
		expect(event?.payload.transcriptPath).toEqual(expect.stringContaining(".jsonl"));
		expect(event?.payload.cwd).toBe("/fixture/repo");
		expect(event?.payload).not.toHaveProperty("task");
	});

	it("turns UserPromptSubmit into PromptSubmitted carrying the prompt text", async () => {
		const [event] = normalize(await fixture("UserPromptSubmit"));
		expect(event?.kind).toBe("PromptSubmitted");
		expect(event?.payload.prompt).toBe("fixture prompt");
	});

	it("turns PreToolUse into ToolCallStarted naming the tool and carrying tool_use_id", async () => {
		const [event] = normalize(await fixture("PreToolUse.Write"));
		expect(event?.kind).toBe("ToolCallStarted");
		expect(event?.payload.tool).toBe("Write");
		expect(event?.payload.toolUseId).toBe("toolu_01G2gw3gjGJ4J1X2gc3wrZh8");
	});

	it("emits FileMutated alongside ToolCallCompleted for a write tool (Write, from the captured fixtures)", async () => {
		const events = normalize(await fixture("PostToolUse.Write"));
		expect(events.map((event) => event.kind)).toEqual(
			expect.arrayContaining(["ToolCallCompleted", "FileMutated"]),
		);
		const mutation = events.find((event) => event.kind === "FileMutated");
		expect(mutation?.payload.path).toBe("/fixture/repo/note.txt");
	});

	it("never stores original file content or the structured patch on ToolCallCompleted for a write tool", async () => {
		const events = normalize(await fixture("PostToolUse.Write"));
		const completed = events.find((event) => event.kind === "ToolCallCompleted");
		const response = completed?.payload.response as Record<string, unknown>;
		expect(response).not.toHaveProperty("content");
		expect(response).not.toHaveProperty("originalFile");
		expect(response).not.toHaveProperty("structuredPatch");
		expect(completed?.payload.toolUseId).toBe("toolu_01G2gw3gjGJ4J1X2gc3wrZh8");
		expect(completed?.payload.durationMs).toBe(3);
	});

	it("uses an allowlist for the Edit response, dropping originalFile/newString/oldString/structuredPatch", async () => {
		const events = normalize(await fixture("PostToolUse.Edit"));
		const completed = events.find((event) => event.kind === "ToolCallCompleted");
		expect(completed?.payload.response).toEqual({
			filePath: "/fixture/repo/edit-me.txt",
			replaceAll: false,
			userModified: false,
		});
		const mutation = events.find((event) => event.kind === "FileMutated");
		expect(mutation?.payload.path).toBe("/fixture/repo/edit-me.txt");
	});

	it("uses an allowlist for the snake_case NotebookEdit response, dropping the whole-notebook fields", async () => {
		const events = normalize(await fixture("PostToolUse.NotebookEdit"));
		const completed = events.find((event) => event.kind === "ToolCallCompleted");
		expect(completed?.payload.response).toEqual({
			notebook_path: "/fixture/repo/notes.ipynb",
			cell_id: "c1",
			cell_type: "code",
			edit_mode: "replace",
			language: "python",
			error: "",
		});
		const responseText = JSON.stringify(completed?.payload.response);
		expect(responseText).not.toContain("print");
		// finding 2: notebook_path is now verified by a real fixture, so FileMutated may read it.
		const mutation = events.find((event) => event.kind === "FileMutated");
		expect(mutation?.payload.path).toBe("/fixture/repo/notes.ipynb");
	});

	it("does not treat MultiEdit as a write tool, since no fixture proves it exists in this build", () => {
		const payload = {
			hook_event_name: "PostToolUse",
			tool_name: "MultiEdit",
			tool_use_id: "toolu_multi",
			tool_input: { file_path: "/fixture/repo/multi.txt" },
			tool_response: { filePath: "/fixture/repo/multi.txt", type: "update" },
		};
		const events = normalize(payload);
		expect(events.map((event) => event.kind)).toEqual(["ToolCallCompleted"]);
		const completed = events[0];
		expect(completed?.payload.response).toEqual({ completed: true, responseKeys: ["filePath", "type"] });
	});

	// Review finding: the fold's claims branch reads CommandStarted, but nothing
	// emitted it before this fix, so run.claims.commands was silently empty for
	// every real run - a confident wrong zero rather than a visible gap.
	it("emits CommandStarted alongside ToolCallStarted for a Bash pre-tool hook", async () => {
		const events = normalize(await fixture("PreToolUse.Bash"));
		expect(events.map((event) => event.kind)).toEqual(["ToolCallStarted", "CommandStarted"]);
		const started = events.find((event) => event.kind === "CommandStarted");
		expect(started?.payload).toEqual({ command: "echo done", toolUseId: "toolu_01QpvqpHjkF3fXz9XmGAQ4fm" });
	});

	it("does not emit CommandStarted for a non-Bash pre-tool hook", async () => {
		const events = normalize(await fixture("PreToolUse.Write"));
		expect(events.map((event) => event.kind)).toEqual(["ToolCallStarted"]);
	});

	it("emits CommandCompleted for a Bash tool result", async () => {
		const events = normalize(await fixture("PostToolUse.Bash"));
		expect(events.map((event) => event.kind)).toContain("CommandCompleted");
	});

	it("emits a CommandCompleted payload with the exact summarized shape for the Bash fixture", async () => {
		const events = normalize(await fixture("PostToolUse.Bash"));
		const commandCompleted = events.find((event) => event.kind === "CommandCompleted");
		expect(commandCompleted?.payload).toEqual({
			command: "echo done",
			stdout: "done",
			stderr: "",
			interrupted: false,
			durationMs: 84,
		});
	});

	it("summarizes a Bash ToolCallCompleted response to stdout, stderr and interrupted only", async () => {
		const events = normalize(await fixture("PostToolUse.Bash"));
		const completed = events.find((event) => event.kind === "ToolCallCompleted");
		expect(completed?.payload.response).toEqual({ stdout: "done", stderr: "", interrupted: false });
	});

	it("truncates a large Bash stdout/stderr to a bounded length instead of storing it whole", () => {
		const huge = "x".repeat(10_000);
		const payload = {
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_use_id: "toolu_big",
			tool_input: { command: "yes" },
			tool_response: { stdout: huge, stderr: "", interrupted: false },
		};
		const events = normalize(payload);
		const completed = events.find((event) => event.kind === "ToolCallCompleted");
		const stdout = completed?.payload.response as Record<string, unknown>;
		expect(typeof stdout.stdout).toBe("string");
		expect((stdout.stdout as string).length).toBeLessThan(huge.length);
	});

	it("records only completion and response key names for a non-write, non-Bash tool (Read)", async () => {
		const events = normalize(await fixture("PostToolUse.Read"));
		expect(events.map((event) => event.kind)).toEqual(["ToolCallCompleted"]);
		const completed = events[0];
		const response = completed?.payload.response as Record<string, unknown>;
		expect(response).toEqual({ completed: true, responseKeys: ["file", "type"] });
		expect(JSON.stringify(response)).not.toContain("seed");
	});

	it("turns Stop into AgentStopped", async () => {
		const [event] = normalize(await fixture("Stop"));
		expect(event?.kind).toBe("AgentStopped");
	});

	it("returns no events for an unrecognised payload instead of throwing", () => {
		expect(normalize({ hook_event_name: "SomethingNew" })).toEqual([]);
	});

	it("returns no events for a non-object payload instead of throwing", () => {
		expect(normalize("not json")).toEqual([]);
		expect(normalize(null)).toEqual([]);
		expect(normalize(undefined)).toEqual([]);
	});

	it("returns no events for a raw array payload instead of throwing", () => {
		expect(normalize([1, 2, 3])).toEqual([]);
		expect(normalize([])).toEqual([]);
	});

	it("treats a non-object tool_input as absent instead of throwing", () => {
		const events = normalize({
			hook_event_name: "PreToolUse",
			tool_name: "Write",
			tool_use_id: "toolu_x",
			tool_input: "oops, a string instead of an object",
		});
		expect(events).toEqual([
			{
				ts: expect.any(String),
				source: "claude-code",
				kind: "ToolCallStarted",
				payload: { tool: "Write", input: {}, toolUseId: "toolu_x" },
			},
		]);
	});

	it("logs to stderr and still returns no events when normalization throws unexpectedly", () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const throwing = new Proxy(
				{},
				{
					get() {
						throw new Error("boom");
					},
				},
			);
			expect(normalize(throwing)).toEqual([]);
			expect(stderrSpy).toHaveBeenCalledTimes(1);
			const [message] = stderrSpy.mock.calls[0] as [string];
			expect(message).toContain("normalization failed");
			expect(message).toContain("hook_event_name=unknown");
		} finally {
			stderrSpy.mockRestore();
		}
	});

	it("returns no events instead of throwing when a recognised hook is missing every field it would normally read", () => {
		expect(normalize({ hook_event_name: "PreToolUse" })).toEqual([{
			ts: expect.any(String),
			source: "claude-code",
			kind: "ToolCallStarted",
			payload: { tool: "", input: {}, toolUseId: null },
		}]);
	});

	it("marks every event as sourced from claude-code", async () => {
		const events = normalize(await fixture("PostToolUse.Write"));
		expect(events.every((event) => event.source === "claude-code")).toBe(true);
	});

	it("produces only JSON-plain payloads that the checksum layer accepts, for every captured fixture", async () => {
		const names = [
			"SessionStart",
			"UserPromptSubmit",
			"PreToolUse.Read",
			"PostToolUse.Read",
			"PreToolUse.Write",
			"PostToolUse.Write",
			"PreToolUse.Edit",
			"PostToolUse.Edit",
			"PreToolUse.NotebookEdit",
			"PostToolUse.NotebookEdit",
			"PreToolUse.Bash",
			"PostToolUse.Bash",
			"Stop",
		];
		for (const name of names) {
			const events = normalize(await fixture(name));
			for (const draft of events) {
				const stored: AgentEvent = { ...draft, runId: 1, seq: 0 };
				expect(() => checksumOf(stored)).not.toThrow();
			}
		}
	});
});

describe("claudeCodeAdapter", () => {
	it("identifies itself as claude-code", () => {
		expect(claudeCodeAdapter.id).toBe("claude-code");
	});

	it("enrich returns no events when there is no transcript path", async () => {
		const events = await claudeCodeAdapter.enrich(
			{
				id: 1,
				task: "t",
				state: "RUNNING",
				baseSha: null,
				endSha: null,
				startedAt: "2026-09-09T10:00:00.000Z",
				endedAt: null,
				hasGaps: false,
				claims: { mutatedPaths: [], commands: [] },
				usage: [],
			},
			{ transcriptPath: null },
		);
		expect(events).toEqual([]);
	});
});
