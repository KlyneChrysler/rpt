import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { checksumOf, verifyChecksum } from "../domain/checksum.js";
import type { AgentEvent, DraftEvent, RunId, StoredEvent } from "../domain/events.js";
import { eventLogOf } from "./paths.js";

const MAX_PAYLOAD_BYTES = 8192;

export type ReadResult = { events: AgentEvent[]; gapCount: number };

export async function appendEvent(
	rptDir: string,
	runId: RunId,
	draft: DraftEvent,
): Promise<AgentEvent> {
	const path = eventLogOf(rptDir, runId);
	await mkdir(dirname(path), { recursive: true });
	await ensureExists(path);
	const release = await lockfile.lock(path, { retries: { retries: 100, minTimeout: 2, maxTimeout: 20 } });
	try {
		const event: AgentEvent = { ...draft, payload: capPayload(draft.payload), runId, seq: await nextSeq(path) };
		const stored: StoredEvent = { ...event, checksum: checksumOf(event) };
		await appendFile(path, `${JSON.stringify(stored)}\n`, "utf8");
		return event;
	} finally {
		await release();
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
	if (!verifyChecksum(stored)) return null;
	const { checksum, ...event } = stored;
	return event;
}

function capPayload(payload: Record<string, unknown>): Record<string, unknown> {
	if (Buffer.byteLength(JSON.stringify(payload)) <= MAX_PAYLOAD_BYTES) return payload;
	const capped = Object.fromEntries(
		Object.entries(payload).map(([key, value]) => [key, capValue(value)]),
	);
	return { ...capped, truncated: true };
}

function capValue(value: unknown): unknown {
	if (typeof value !== "string" || Buffer.byteLength(value) <= 1024) return value;
	return `${value.slice(0, 1024)}...`;
}

async function nextSeq(path: string): Promise<number> {
	const text = await readOrEmpty(path);
	return text === "" ? 0 : text.split("\n").filter((line) => line !== "").length;
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
