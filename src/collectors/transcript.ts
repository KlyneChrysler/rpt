import { readFile } from "node:fs/promises";
import type { DraftEvent } from "../domain/events.js";

type TranscriptUsage = {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
};

type TranscriptRecord = {
	type?: string;
	timestamp?: string;
	message?: { model?: string; usage?: TranscriptUsage };
};

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
	const usage = record.message.usage;
	return [
		{
			ts: record.timestamp ?? new Date().toISOString(),
			source: "claude-code",
			kind: "ModelUsageRecorded",
			payload: {
				model: record.message.model ?? "unknown",
				input: usage.input_tokens ?? 0,
				output: usage.output_tokens ?? 0,
				cacheRead: usage.cache_read_input_tokens ?? 0,
				cacheCreate: usage.cache_creation_input_tokens ?? 0,
			},
		},
	];
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
