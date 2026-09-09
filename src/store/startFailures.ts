import { appendFile, mkdir, readFile } from "node:fs/promises";
import { startFailuresOf } from "./paths.js";

export type StartFailure = { ts: string; reason: string };

// The record of a session rpt could not observe at all. A run that fails to start
// leaves no event log, so there is nowhere to append a GapRecorded - and yet its
// absence from the history is indistinguishable from a session that simply never
// happened. This file is that distinction, and it is the only reason a user ever
// gets for why a whole session went unrecorded.
export async function recordStartFailure(rptDir: string, reason: string): Promise<void> {
	await mkdir(rptDir, { recursive: true });
	const failure: StartFailure = { ts: new Date().toISOString(), reason };
	// Leading newline, the same guard appendGapUnlocked uses and for the same
	// reason: a crash can leave a torn, newline-less fragment at the end, and an
	// append landing directly against it would merge into one unreadable line and
	// lose both records instead of just the torn one. Doing it with a byte rather
	// than a read-then-append keeps this write a single call - this is a
	// best-effort recorder of last resort, and every step it takes is a step that
	// can fail. readStartFailures drops the blank line it can leave behind.
	await appendFile(startFailuresOf(rptDir), `\n${JSON.stringify(failure)}\n`, "utf8");
}

// A line that cannot be read back is dropped rather than thrown on: this file
// exists to make a failure visible, so failing to read it must not become a second
// failure that hides the first.
export async function readStartFailures(rptDir: string): Promise<StartFailure[]> {
	const text = await readOrEmpty(startFailuresOf(rptDir));
	return text
		.split("\n")
		.filter((line) => line !== "")
		.map(parseFailure)
		.filter((failure): failure is StartFailure => failure !== null);
}

function parseFailure(line: string): StartFailure | null {
	try {
		const value = JSON.parse(line) as Partial<StartFailure>;
		return typeof value?.ts === "string" && typeof value.reason === "string"
			? { ts: value.ts, reason: value.reason }
			: null;
	} catch {
		return null;
	}
}

async function readOrEmpty(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}
