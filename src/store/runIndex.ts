import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { z } from "zod";
import type { RunId } from "../domain/events.js";
import { isTerminal, RUN_STATES, type RunState } from "../domain/state.js";
import { withInProcessLock } from "./inProcessLock.js";
import { runIndexOf } from "./paths.js";

export type RunIndexEntry = {
	id: RunId;
	task: string;
	state: RunState;
	startedAt: string;
	endedAt: string | null;
};

export type IndexReadResult = { entries: RunIndexEntry[]; corruptLines: number };

// Validated as untrusted data, because that is what it is: a hand-edited or
// half-written line is valid JSON far more often than it is a valid entry, and a
// row that parses but has no id, no task or a state rpt has never heard of used to
// count as a good row. That is the shape of the bug this schema closes - it is not
// enough for the parse not to throw.
const entrySchema = z.object({
	id: z.number().int(),
	task: z.string(),
	state: z.enum(RUN_STATES),
	startedAt: z.string(),
	endedAt: z.string().nullable(),
});

export class CorruptIndexError extends Error {
	constructor(path: string, corruptLines: number) {
		super(
			`refusing to start a run: ${path} has ${corruptLines} corrupt line(s), so the next run id cannot be determined - remove the bad line(s) to recover`,
		);
		this.name = "CorruptIndexError";
	}
}

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
		const { entries, corruptLines } = await readIndexAt(path);
		// Allocating on top of a hole is how one bad line becomes permanent damage:
		// the highest id is no longer knowable, so the next run either collides with
		// a run already on disk or is numbered from a value that was never read.
		// Refusing is loud, visible in the same warning the listing shows, and
		// recoverable by editing the line out. Allocating is silent and is not.
		if (corruptLines > 0) throw new CorruptIndexError(path, corruptLines);
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
	const { entries } = await readIndex(rptDir);
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
	const path = runIndexOf(rptDir);
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
export async function readIndex(rptDir: string): Promise<IndexReadResult> {
	return readIndexAt(runIndexOf(rptDir));
}

async function readIndexAt(path: string): Promise<IndexReadResult> {
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
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	const entry = entrySchema.safeParse(parsed);
	return entry.success ? entry.data : null;
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
