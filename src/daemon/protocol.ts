import { join } from "node:path";
import type { DraftEvent, RunId } from "../domain/events.js";

export type Frame = { runId: RunId; draft: DraftEvent };

export function socketPathOf(rptDir: string): string {
	return join(rptDir, "daemon.sock");
}

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
