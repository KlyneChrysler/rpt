import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { RunId } from "../domain/events.js";
import { isTerminal, type RunState } from "../domain/state.js";
import { withInProcessLock } from "./inProcessLock.js";

export type RunIndexEntry = {
	id: RunId;
	task: string;
	state: RunState;
	startedAt: string;
	endedAt: string | null;
};

export async function allocateRunId(rptDir: string): Promise<RunId> {
	const path = await preparedIndex(rptDir);
	return withInProcessLock(path, () => allocateRunIdLocked(path));
}

// The in-process mutex above already serializes same-process callers, so this
// cross-process lock only ever has to wait out a genuinely separate process; a
// modest retry budget is enough (see eventLog.ts for why raising it further
// would be masking contention rather than removing it).
async function allocateRunIdLocked(path: string): Promise<RunId> {
	const release = await lockfile.lock(path, { retries: { retries: 20, minTimeout: 5, maxTimeout: 100 } });
	try {
		await ensureTrailingNewline(path);
		const highest = (await readEntries(path)).reduce((max, entry) => Math.max(max, entry.id), 0);
		const id = highest + 1;
		await appendFile(path, `${JSON.stringify(reserved(id))}\n`, "utf8");
		return id;
	} finally {
		await release();
	}
}

export async function upsertRun(rptDir: string, entry: RunIndexEntry): Promise<void> {
	const path = await preparedIndex(rptDir);
	await withInProcessLock(path, () => upsertRunLocked(path, entry));
}

async function upsertRunLocked(path: string, entry: RunIndexEntry): Promise<void> {
	const release = await lockfile.lock(path, { retries: { retries: 20, minTimeout: 5, maxTimeout: 100 } });
	try {
		await ensureTrailingNewline(path);
		await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
	} finally {
		await release();
	}
}

export async function listRuns(rptDir: string): Promise<RunIndexEntry[]> {
	const latest = new Map<RunId, RunIndexEntry>();
	for (const entry of await readEntries(join(rptDir, "index.jsonl"))) latest.set(entry.id, entry);
	return [...latest.values()].sort((left, right) => right.id - left.id);
}

export async function activeRun(rptDir: string): Promise<RunIndexEntry | null> {
	const candidates = (await listRuns(rptDir)).filter(isAdjudicable);
	return candidates[0] ?? null;
}

function isAdjudicable(entry: RunIndexEntry): boolean {
	return entry.state !== "RUNNING" && !isTerminal(entry.state);
}

function reserved(id: RunId): RunIndexEntry {
	return { id, task: "", state: "RUNNING", startedAt: new Date().toISOString(), endedAt: null };
}

async function preparedIndex(rptDir: string): Promise<string> {
	await mkdir(rptDir, { recursive: true });
	const path = join(rptDir, "index.jsonl");
	try {
		await writeFile(path, "", { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	return path;
}

async function readEntries(path: string): Promise<RunIndexEntry[]> {
	const text = await readOrEmpty(path);
	return text
		.split("\n")
		.filter((line) => line !== "")
		.flatMap((line) => parseEntry(line));
}

function parseEntry(line: string): RunIndexEntry[] {
	try {
		return [JSON.parse(line) as RunIndexEntry];
	} catch {
		return [];
	}
}

// A crash can leave a torn, newline-less fragment at the end of the log. Without
// this, the next append would land directly after it with no separator, merging
// into one unparseable line and losing both records instead of gapping just the
// torn one. Must run inside the same lock as the append that follows it.
async function ensureTrailingNewline(path: string): Promise<void> {
	const text = await readOrEmpty(path);
	if (text !== "" && !text.endsWith("\n")) await appendFile(path, "\n", "utf8");
}

async function readOrEmpty(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}
