import { readFile } from "node:fs/promises";
import type { DraftEvent } from "../domain/events.js";

// The fields below are typed as `unknown`, not `number`, on purpose: this is
// parsed straight out of an untrusted transcript file (JSON.parse gives no
// runtime guarantee that a field claimed to be a token count actually is
// one), and `usageOf` below is the one place responsible for checking that
// before the value ever reaches a DraftEvent payload.
type TranscriptUsage = {
	input_tokens?: unknown;
	output_tokens?: unknown;
	cache_read_input_tokens?: unknown;
	cache_creation_input_tokens?: unknown;
};

type TranscriptRecord = {
	type?: string;
	timestamp?: string;
	message?: { model?: string; usage?: TranscriptUsage };
};

type Usage = { input: number; output: number; cacheRead: number; cacheCreate: number };

export async function readTranscriptUsage(path: string): Promise<DraftEvent[]> {
	const text = await readOrEmpty(path);
	return text
		.split("\n")
		.filter((line) => line !== "")
		.flatMap((line) => usageEvent(line));
}

function usageEvent(line: string): DraftEvent[] {
	const record = parse(line);
	if (record?.type !== "assistant" || record.message?.usage === undefined) return [];
	const usage = usageOf(record.message.usage);
	// A usage object that carries the wrong type for a token count (a string,
	// null, ...) is unpriceable and untrustworthy in equal measure - folding a
	// non-number to NaN would make costOf report a NaN "price" instead of the
	// honest null it reports for a genuinely missing rate. Drop the record.
	if (usage === null) return [];
	return [
		{
			ts: record.timestamp ?? new Date().toISOString(),
			source: "claude-code",
			kind: "ModelUsageRecorded",
			payload: { model: record.message.model ?? "unknown", ...usage },
		},
	];
}

function usageOf(usage: TranscriptUsage): Usage | null {
	const input = tokenCount(usage.input_tokens);
	const output = tokenCount(usage.output_tokens);
	const cacheRead = tokenCount(usage.cache_read_input_tokens);
	const cacheCreate = tokenCount(usage.cache_creation_input_tokens);
	if (input === null || output === null || cacheRead === null || cacheCreate === null) return null;
	return { input, output, cacheRead, cacheCreate };
}

// A field that is simply absent legitimately defaults to zero (some fields
// are omitted entirely when their value would be zero). A field that is
// present but not a finite number is a different situation - malformed data,
// not an absent one - and is reported as `null` so the caller drops the
// whole record rather than inventing a token count.
function tokenCount(value: unknown): number | null {
	if (value === undefined) return 0;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parse(line: string): TranscriptRecord | null {
	try {
		return JSON.parse(line) as TranscriptRecord;
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
