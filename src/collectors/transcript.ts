// Stub for Task 13. readTranscriptUsage will parse a Claude Code transcript.jsonl
// and emit ModelUsageRecorded (and similar) DraftEvents from it.

import type { DraftEvent } from "../domain/events.js";

export async function readTranscriptUsage(_transcriptPath: string): Promise<DraftEvent[]> {
	throw new Error("not implemented: readTranscriptUsage is written in Task 13");
}
