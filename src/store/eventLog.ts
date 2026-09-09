import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { checksumOf, verifyChecksum } from "../domain/checksum.js";
import type { AgentEvent, DraftEvent, RunId, StoredEvent } from "../domain/events.js";
import { withInProcessLock } from "./inProcessLock.js";
import { eventLogOf } from "./paths.js";

export const MAX_PAYLOAD_BYTES = 8192;
const MAX_FIELD_BYTES = 1024;
const TRUNCATION_SUFFIX = "...";

export type ReadResult = { events: AgentEvent[]; gapCount: number };

export async function appendEvent(rptDir: string, runId: RunId, draft: DraftEvent): Promise<AgentEvent> {
	const path = eventLogOf(rptDir, runId);
	await mkdir(dirname(path), { recursive: true });
	await ensureExists(path);
	return withInProcessLock(path, () => appendEventLocked(path, runId, draft));
}

async function appendEventLocked(path: string, runId: RunId, draft: DraftEvent): Promise<AgentEvent> {
	// The in-process mutex above already serializes same-process callers, so this
	// cross-process lock only ever has to wait out a genuinely separate process; a
	// modest retry budget is enough. If it's still unavailable, this call rejects —
	// a later task turns that failure into a recorded gap rather than failing the agent.
	const release = await lockfile.lock(path, { retries: { retries: 10, minTimeout: 5, maxTimeout: 100 } });
	try {
		await ensureTrailingNewline(path);
		const event: AgentEvent = { ...draft, payload: capPayload(draft.payload), runId, seq: await nextSeq(path) };
		const stored: StoredEvent = { ...event, checksum: checksumOf(event) };
		await appendFile(path, `${JSON.stringify(stored)}\n`, "utf8");
		return event;
	} finally {
		await release();
	}
}

// The gap of last resort, and the only write in this file that takes neither the
// in-process mutex nor the cross-process file lock. That is the entire point: it
// is called only after a locked append against this same path has already failed,
// so repeating that append would fail identically and the loss would be silent.
// Dropping the locks is safe here and nowhere else, because of what a gap line
// means - the worst an unlocked append can produce is a torn line, and readEvents
// already counts a torn line as a gap. An unlocked write therefore cannot make the
// record claim more than the truth; not writing at all can.
export async function appendGapUnlocked(rptDir: string, runId: RunId, draft: DraftEvent): Promise<void> {
	const path = eventLogOf(rptDir, runId);
	await mkdir(dirname(path), { recursive: true });
	const event: AgentEvent = { ...draft, payload: capPayload(draft.payload), runId, seq: await bestEffortSeq(path) };
	const stored: StoredEvent = { ...event, checksum: checksumOf(event) };
	// A leading newline instead of ensureTrailingNewline: it closes off a torn
	// fragment left by whoever holds the lock without a second round trip through
	// the filesystem, and readEvents discards the blank line it can leave behind.
	await appendFile(path, `\n${JSON.stringify(stored)}\n`, "utf8");
}

// seq is positional metadata and this append deliberately runs without the lock
// that makes a position knowable, so a count read outside the lock is the most
// this can honestly claim. -1 records that even that could not be determined,
// rather than asserting a position that was never true.
async function bestEffortSeq(path: string): Promise<number> {
	try {
		return await nextSeq(path);
	} catch {
		return -1;
	}
}

export async function readEvents(rptDir: string, runId: RunId): Promise<ReadResult> {
	const text = await readOrEmpty(eventLogOf(rptDir, runId));
	if (text === "") return { events: [], gapCount: 0 };
	const lines = text.split("\n").filter((line) => line !== "");
	const events: AgentEvent[] = [];
	let gapCount = 0;
	for (const line of lines) {
		const event = parseLine(line);
		if (event === null) gapCount += 1;
		else events.push(event);
	}
	return { events, gapCount };
}

function parseLine(line: string): AgentEvent | null {
	let stored: StoredEvent;
	try {
		stored = JSON.parse(line) as StoredEvent;
	} catch {
		return null;
	}
	// verifyChecksum cannot throw here: JSON.parse only ever produces JSON-plain
	// values, and canonicalize (called inside verifyChecksum) always accepts those.
	if (!verifyChecksum(stored)) return null;
	const { checksum, ...event } = stored;
	return event;
}

function capPayload(payload: Record<string, unknown>): Record<string, unknown> {
	const originalBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
	if (originalBytes <= MAX_PAYLOAD_BYTES) return payload;

	const perFieldCapped = {
		...Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, capValue(value)])),
		truncated: true,
	};
	if (Buffer.byteLength(JSON.stringify(perFieldCapped), "utf8") <= MAX_PAYLOAD_BYTES) return perFieldCapped;

	// Per-field capping alone didn't bring the total under budget (many small fields,
	// or a large non-string value). Replace the payload entirely so the constant's
	// name stays true: whatever comes back is guaranteed to fit.
	return { truncated: true, originalBytes, originalKeys: Object.keys(payload) };
}

function capValue(value: unknown): unknown {
	if (typeof value !== "string" || Buffer.byteLength(value, "utf8") <= MAX_FIELD_BYTES) return value;
	const budget = MAX_FIELD_BYTES - Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");
	return `${truncateToByteBudget(value, budget)}${TRUNCATION_SUFFIX}`;
}

// Truncates to at most maxBytes UTF-8 bytes without splitting a multi-byte
// character: continuation bytes are 10xxxxxx, so back off until the cut point
// isn't one.
function truncateToByteBudget(value: string, maxBytes: number): string {
	const buffer = Buffer.from(value, "utf8");
	let end = Math.min(maxBytes, buffer.byteLength);
	while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
	return buffer.subarray(0, end).toString("utf8");
}

async function nextSeq(path: string): Promise<number> {
	const text = await readOrEmpty(path);
	return text === "" ? 0 : text.split("\n").filter((line) => line !== "").length;
}

// A crash can leave a torn, newline-less fragment at the end of the log. Without
// this, the next append would land directly after it with no separator, merging
// into one unparseable line and losing both records instead of gapping just the
// torn one. Must run inside the same lock as the append that follows it.
async function ensureTrailingNewline(path: string): Promise<void> {
	const text = await readOrEmpty(path);
	if (text !== "" && !text.endsWith("\n")) await appendFile(path, "\n", "utf8");
}

async function ensureExists(path: string): Promise<void> {
	try {
		await writeFile(path, "", { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
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
