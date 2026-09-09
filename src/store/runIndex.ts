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

export type IndexReadResult = { entries: RunIndexEntry[]; corruptLines: number };

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
		const { entries } = await readIndex(path);
		const highest = entries.reduce((max, entry) => Math.max(max, entry.id), 0);
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
	const { entries } = await readIndex(join(rptDir, "index.jsonl"));
	return latestEntries(entries);
}

// The index is an append-only log: a run gets a RUNNING placeholder row the moment
// its id is allocated, then further rows as its state changes. Any caller that lists
// runs needs the latest row per id, newest run first - not the raw rows readIndex
// hands back. Exported so a caller that also needs readIndex's corruptLines (which
// listRuns discards) can fold the same raw entries the same way, rather than keeping
// a second, independently maintained copy of this rule (see src/cli/index.ts).
export function latestEntries(entries: readonly RunIndexEntry[]): RunIndexEntry[] {
	const latest = new Map<RunId, RunIndexEntry>();
	for (const entry of entries) latest.set(entry.id, entry);
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

// The index is a rebuildable cache, not the source of truth (that's the event log), so a
// corrupt line must not make the tool unusable. But it also must not vanish without a trace:
// a run silently dropped here is a run activeRun can no longer see to gate. corruptLines lets
// every caller know the count, and a non-zero count is also reported to stderr immediately.
export async function readIndex(path: string): Promise<IndexReadResult> {
	const text = await readOrEmpty(path);
	const lines = text.split("\n").filter((line) => line !== "");
	const entries: RunIndexEntry[] = [];
	let corruptLines = 0;
	for (const line of lines) {
		const entry = parseEntry(line);
		if (entry === null) corruptLines += 1;
		else entries.push(entry);
	}
	if (corruptLines > 0) warnCorruptLines(path, corruptLines);
	return { entries, corruptLines };
}

function parseEntry(line: string): RunIndexEntry | null {
	try {
		return JSON.parse(line) as RunIndexEntry;
	} catch {
		return null;
	}
}

function warnCorruptLines(path: string, corruptLines: number): void {
	process.stderr.write(`rpt: ${path}: ${corruptLines} unparseable line(s) ignored in the run index\n`);
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
