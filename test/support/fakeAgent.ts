import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { handleHook } from "../../src/cli/hook.js";

// Every payload below is built from the real Claude Code hook fixtures in
// test/fixtures/hooks (captured from Claude Code 2.1.266), not invented from
// this brief - only the fields a script needs to vary (cwd, file paths,
// command text, edited content) are overridden on top of the captured
// shape. See that directory's README for what was verified and what was
// not: Write, Edit and NotebookEdit are the only confirmed write tools:
// MultiEdit does not exist in the captured build, so nothing here uses it.
export type FakeStep =
	| { kind: "start"; transcriptPath: string | null }
	| { kind: "edit"; path: string; body: string }
	| { kind: "bash"; command: string }
	| { kind: "stop" };

const FIXTURES_DIR = join("test", "fixtures", "hooks");

export async function driveFakeAgent(repo: string, script: FakeStep[]): Promise<void> {
	for (const step of script) await runStep(repo, step);
}

async function runStep(repo: string, step: FakeStep): Promise<void> {
	if (step.kind === "start") return handleHook(repo, await sessionStartPayload(repo, step.transcriptPath));
	if (step.kind === "edit") return runEdit(repo, step.path, step.body);
	if (step.kind === "bash") return runBash(repo, step.command);
	return handleHook(repo, await stopPayload(repo));
}

// Mirrors the real PreToolUse/PostToolUse pair Claude Code sends around a
// write tool call: the file lands on disk, then the two hooks fire in order,
// exactly as they do in a live session.
async function runEdit(repo: string, path: string, body: string): Promise<void> {
	await writeFile(join(repo, path), body);
	await handleHook(repo, await preToolUsePayload(repo, "Edit", editToolInput(path, body)));
	await handleHook(repo, await postToolUseEditPayload(repo, path, body));
}

async function runBash(repo: string, command: string): Promise<void> {
	await handleHook(repo, await preToolUsePayload(repo, "Bash", bashToolInput(command)));
	await handleHook(repo, await postToolUseBashPayload(repo, command));
}

async function sessionStartPayload(repo: string, transcriptPath: string | null): Promise<unknown> {
	return { ...(await fixture("SessionStart")), cwd: repo, transcript_path: transcriptPath };
}

async function stopPayload(repo: string): Promise<unknown> {
	return { ...(await fixture("Stop")), cwd: repo };
}

function editToolInput(path: string, body: string): Record<string, unknown> {
	return { file_path: path, old_string: "", new_string: body, replace_all: false };
}

function bashToolInput(command: string): Record<string, unknown> {
	return { command, description: command };
}

async function preToolUsePayload(
	repo: string,
	tool: "Edit" | "Bash",
	input: Record<string, unknown>,
): Promise<unknown> {
	return { ...(await fixture(`PreToolUse.${tool}`)), cwd: repo, tool_input: input };
}

// Field naming here follows the fixture exactly: the Edit response is
// camelCase (filePath, newString, oldString, replaceAll, userModified) -
// see test/fixtures/hooks/README.md on why that inconsistency with
// NotebookEdit's snake_case matters to the adapter's allowlist.
async function postToolUseEditPayload(repo: string, path: string, body: string): Promise<unknown> {
	const base = await fixture("PostToolUse.Edit");
	const response = base.tool_response as Record<string, unknown>;
	return {
		...base,
		cwd: repo,
		tool_input: editToolInput(path, body),
		tool_response: { ...response, filePath: path, newString: body, oldString: "", replaceAll: false, userModified: false },
	};
}

async function postToolUseBashPayload(repo: string, command: string): Promise<unknown> {
	return { ...(await fixture("PostToolUse.Bash")), cwd: repo, tool_input: bashToolInput(command) };
}

async function fixture(name: string): Promise<Record<string, unknown>> {
	const text = await readFile(join(FIXTURES_DIR, `${name}.json`), "utf8");
	return JSON.parse(text) as Record<string, unknown>;
}
