import { createHash } from "node:crypto";
import type { AgentEvent, StoredEvent } from "./events.js";

export function canonicalize(event: AgentEvent): string {
	return JSON.stringify(sortValue(event, ""));
}

export function checksumOf(event: AgentEvent): string {
	return createHash("sha256").update(canonicalize(event)).digest("hex");
}

export function verifyChecksum(stored: StoredEvent): boolean {
	const { checksum, ...event } = stored;
	return checksumOf(event) === checksum;
}

function sortValue(value: unknown, path: string): unknown {
	if (value === null) return null;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return value;

	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			const displayPath = path || "<root>";
			throw new Error(`${displayPath}: found ${value}, expected JSON-plain value`);
		}
		return value;
	}

	if (Array.isArray(value)) {
		return value.map((item, index) => {
			const itemPath = path ? `${path}[${index}]` : `[${index}]`;
			return sortValue(item, itemPath);
		});
	}

	if (typeof value === "object") {
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) {
			const displayPath = path || "<root>";
			const type = proto.constructor.name;
			throw new Error(`${displayPath}: found ${type}, expected JSON-plain value`);
		}

		const entries = Object.entries(value as Record<string, unknown>).sort(byKey);
		return Object.fromEntries(
			entries.map(([key, nested]) => {
				const nestedPath = path ? `${path}.${key}` : key;
				return [key, sortValue(nested, nestedPath)];
			})
		);
	}

	const displayPath = path || "<root>";
	const type = getType(value);
	throw new Error(`${displayPath}: found ${type}, expected JSON-plain value`);
}

function getType(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (Number.isNaN(value)) return "NaN";
	if (typeof value === "function") return "function";
	if (typeof value === "symbol") return "symbol";
	if (typeof value === "bigint") return "bigint";
	if (value instanceof Date) return "Date";
	if (value instanceof Map) return "Map";
	if (value instanceof Set) return "Set";
	return typeof value;
}

function byKey(left: [string, unknown], right: [string, unknown]): number {
	return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
}
