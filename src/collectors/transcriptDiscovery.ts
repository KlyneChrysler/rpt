import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Claude Code stores a session transcript at
// ~/.claude/projects/<slug>/<sessionId>.jsonl, where the slug is the project's
// absolute path with every character outside [A-Za-z0-9] replaced by a hyphen
// (/Users/me/Desktop/P_NO_16/klyne.dev becomes
// -Users-me-Desktop-P-NO-16-klyne-dev). That layout is observed, not
// documented, so every function here degrades to "found nothing" rather than
// throwing: a changed layout must cost a user a pre-filled pricing file, never
// their ability to run rpt init.
const PROJECTS_DIR = join(homedir(), ".claude", "projects");

// A one-time read at init over a history that can run to hundreds of megabytes.
// The budget bounds it: past this, init stops reading and seeds what it found,
// which is strictly better than an init command that appears to hang.
const READ_BUDGET_BYTES = 64 * 1024 * 1024;

export function transcriptSlugOf(repoRoot: string): string {
	return repoRoot.replace(/[^A-Za-z0-9]/g, "-");
}

export function transcriptDirOf(repoRoot: string, projectsDir: string = PROJECTS_DIR): string {
	return join(projectsDir, transcriptSlugOf(repoRoot));
}

// Every distinct model id this repository's own recorded sessions used, newest
// transcripts first so a truncated read keeps the models most likely to still
// be in use. Returns an empty list for a repository Claude Code has never run
// in, which is the ordinary case at `rpt init`.
export async function modelsInTranscripts(repoRoot: string, projectsDir: string = PROJECTS_DIR): Promise<string[]> {
	const models = new Set<string>();
	let budget = READ_BUDGET_BYTES;
	for (const path of await transcriptPathsNewestFirst(transcriptDirOf(repoRoot, projectsDir))) {
		if (budget <= 0) break;
		const text = await readOrEmpty(path);
		budget -= text.length;
		for (const model of modelsIn(text)) models.add(model);
	}
	return [...models].sort();
}

async function transcriptPathsNewestFirst(dir: string): Promise<string[]> {
	const names = (await readdirOrEmpty(dir)).filter((name) => name.endsWith(".jsonl"));
	const withTimes = await Promise.all(names.map(async (name) => ({ path: join(dir, name), at: await modifiedAt(join(dir, name)) })));
	return withTimes.sort((left, right) => right.at - left.at).map((entry) => entry.path);
}

function modelsIn(text: string): string[] {
	const models: string[] = [];
	for (const line of text.split("\n")) {
		const model = modelOf(line);
		if (model !== null) models.push(model);
	}
	return models;
}

function modelOf(line: string): string | null {
	if (line === "") return null;
	let record: unknown;
	try {
		record = JSON.parse(line);
	} catch {
		return null;
	}
	const message = (record as { type?: unknown; message?: unknown }).message;
	if ((record as { type?: unknown }).type !== "assistant" || typeof message !== "object" || message === null) return null;
	const model = (message as { model?: unknown }).model;
	return typeof model === "string" && model !== "" ? model : null;
}

async function modifiedAt(path: string): Promise<number> {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return 0;
	}
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

async function readOrEmpty(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return "";
	}
}
