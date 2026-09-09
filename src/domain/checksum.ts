import { createHash } from "node:crypto";
import type { AgentEvent, StoredEvent } from "./events.js";

export function canonicalize(event: AgentEvent): string {
	return JSON.stringify(sortValue(event));
}

export function checksumOf(event: AgentEvent): string {
	return createHash("sha256").update(canonicalize(event)).digest("hex");
}

export function verifyChecksum(stored: StoredEvent): boolean {
	const { checksum, ...event } = stored;
	return checksumOf(event) === checksum;
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value === null || typeof value !== "object") return value;
	const entries = Object.entries(value as Record<string, unknown>).sort(byKey);
	return Object.fromEntries(entries.map(([key, nested]) => [key, sortValue(nested)]));
}

function byKey(left: [string, unknown], right: [string, unknown]): number {
	return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
}
