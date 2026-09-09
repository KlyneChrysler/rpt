import { mkdir, readFile, writeFile } from "node:fs/promises";
import lockfile from "proper-lockfile";
import type { RunId } from "../domain/events.js";
import { withInProcessLock } from "./inProcessLock.js";
import { currentPointerOf } from "./paths.js";

export type CurrentRunTransition<T> = (current: RunId | null) => Promise<{ next: RunId | null; result: T }>;

// The current-run pointer is the one piece of mutable state in a system that is
// otherwise a pure fold over an append-only log, and it is the file every hook
// invocation both reads and writes. Locked the same way as runIndex.ts's id
// allocation: an in-process queue collapses same-process races to nothing, and
// proper-lockfile arbitrates the rest against a genuinely separate hook process.
// Callers run their decision *inside* that lock, not just the pointer's own read
// and write around it - the decision of what to do (seal this run? start a new
// one?) has to be made against a pointer value that cannot go stale before the
// write that follows it, or two concurrent callers can both act on the same
// stale read and both seal (or start) the same run.
export async function transitionCurrentRun<T>(rptDir: string, fn: CurrentRunTransition<T>): Promise<T> {
	const path = await preparedPointer(rptDir);
	return withInProcessLock(path, () => transitionLocked(path, fn));
}

export async function readCurrentRunId(rptDir: string): Promise<RunId | null> {
	return parsePointer(await readOrEmpty(await preparedPointer(rptDir)));
}

async function transitionLocked<T>(path: string, fn: CurrentRunTransition<T>): Promise<T> {
	const release = await lockfile.lock(path, { retries: { retries: 20, minTimeout: 5, maxTimeout: 100 } });
	try {
		const current = parsePointer(await readOrEmpty(path));
		const { next, result } = await fn(current);
		if (next !== current) await writeFile(path, next === null ? "" : String(next), "utf8");
		return result;
	} finally {
		await release();
	}
}

// A corrupt or hand-edited pointer file must degrade to "no run in progress"
// rather than crash the reader or be misread as a real run id: Number("") is 0,
// which Number.isInteger accepts, so the empty-pointer case is checked explicitly
// rather than left to fall out of the general numeric parse.
function parsePointer(raw: string): RunId | null {
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	const id = Number(trimmed);
	return Number.isInteger(id) ? id : null;
}

async function preparedPointer(rptDir: string): Promise<string> {
	await mkdir(rptDir, { recursive: true });
	const path = currentPointerOf(rptDir);
	try {
		await writeFile(path, "", { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	return path;
}

async function readOrEmpty(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}
