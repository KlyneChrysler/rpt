import type { DraftEvent, RunId } from "../domain/events.js";

export type Frame = { runId: RunId; draft: DraftEvent };

// The daemon's reply vocabulary. Only OK_REPLY means "this event is in the log";
// the client treats every other reply, and no reply at all, as undelivered.
export const OK_REPLY = "ok";
export const FAILED_REPLY = "failed";

export function encode(frame: Frame): string {
	return `${JSON.stringify(frame)}\n`;
}

export function decode(line: string): Frame | null {
	try {
		const frame = JSON.parse(line) as Frame;
		return typeof frame.runId === "number" && typeof frame.draft?.kind === "string" ? frame : null;
	} catch {
		return null;
	}
}
