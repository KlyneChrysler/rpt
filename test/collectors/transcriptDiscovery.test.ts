import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { modelsInTranscripts, transcriptDirOf, transcriptSlugOf } from "../../src/collectors/transcriptDiscovery.js";

function assistantLine(model: string): string {
	return JSON.stringify({ type: "assistant", message: { model, usage: { input_tokens: 1 } } });
}

async function projectsDirWith(repoRoot: string, files: Record<string, string>): Promise<string> {
	const projects = await mkdtemp(join(tmpdir(), "rpt-projects-"));
	const dir = transcriptDirOf(repoRoot, projects);
	await mkdir(dir, { recursive: true });
	for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body, "utf8");
	return projects;
}

describe("transcriptSlugOf", () => {
	// Verified against a real ~/.claude/projects directory: every character
	// outside [A-Za-z0-9] becomes a hyphen, so both the separators and the
	// dots and underscores inside a path name collapse the same way.
	it("replaces every non-alphanumeric character with a hyphen", () => {
		expect(transcriptSlugOf("/Users/me/Desktop/P_NO_16/klyne.dev")).toBe("-Users-me-Desktop-P-NO-16-klyne-dev");
	});
});

describe("modelsInTranscripts", () => {
	it("finds every distinct model an assistant message names", async () => {
		const repo = "/tmp/some-repo";
		const projects = await projectsDirWith(repo, {
			"a.jsonl": [assistantLine("claude-opus-5"), assistantLine("claude-opus-5")].join("\n"),
			"b.jsonl": assistantLine("claude-haiku-4-5-20251001"),
		});
		expect(await modelsInTranscripts(repo, projects)).toEqual(["claude-haiku-4-5-20251001", "claude-opus-5"]);
	});

	it("is empty for a repository claude code has never run in", async () => {
		const projects = await mkdtemp(join(tmpdir(), "rpt-projects-"));
		expect(await modelsInTranscripts("/tmp/never-used", projects)).toEqual([]);
	});

	it("ignores records that are not assistant messages", async () => {
		const repo = "/tmp/some-repo";
		const projects = await projectsDirWith(repo, {
			"a.jsonl": [JSON.stringify({ type: "user", message: { model: "not-a-model" } }), assistantLine("claude-opus-5")].join("\n"),
		});
		expect(await modelsInTranscripts(repo, projects)).toEqual(["claude-opus-5"]);
	});

	it("skips an unparseable line rather than abandoning the file", async () => {
		const repo = "/tmp/some-repo";
		const projects = await projectsDirWith(repo, { "a.jsonl": ["{not json", assistantLine("claude-opus-5")].join("\n") });
		expect(await modelsInTranscripts(repo, projects)).toEqual(["claude-opus-5"]);
	});

	it("ignores a non-transcript file sitting in the same directory", async () => {
		const repo = "/tmp/some-repo";
		const projects = await projectsDirWith(repo, { "notes.txt": assistantLine("claude-opus-5") });
		expect(await modelsInTranscripts(repo, projects)).toEqual([]);
	});

	// A layout that moved, a home directory that cannot be read: seeding is a
	// convenience, and losing it must never be able to fail rpt init.
	it("returns nothing rather than throwing when the projects directory is absent", async () => {
		expect(await modelsInTranscripts("/tmp/some-repo", "/nonexistent/projects")).toEqual([]);
	});
});
