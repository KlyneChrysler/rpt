import { describe, expect, it } from "vitest";
import { canonicalize, checksumOf, verifyChecksum } from "../../src/domain/checksum.js";
import type { AgentEvent } from "../../src/domain/events.js";

const event: AgentEvent = {
	runId: 1,
	seq: 0,
	ts: "2026-09-09T10:00:00.000Z",
	source: "claude-code",
	kind: "FileMutated",
	payload: { path: "src/auth/pool.ts", operation: "modify" },
};

describe("canonicalize", () => {
	it("orders keys so equal events serialize identically", () => {
		const reordered = { ...event, payload: { operation: "modify", path: "src/auth/pool.ts" } };
		expect(canonicalize(reordered)).toBe(canonicalize(event));
	});

	it("orders nested payload keys too", () => {
		const a = { ...event, payload: { outer: { b: 2, a: 1 } } };
		const b = { ...event, payload: { outer: { a: 1, b: 2 } } };
		expect(canonicalize(a)).toBe(canonicalize(b));
	});
});

describe("checksumOf", () => {
	it("is stable for equal events", () => {
		expect(checksumOf(event)).toBe(checksumOf({ ...event }));
	});

	it("changes when any field changes", () => {
		expect(checksumOf({ ...event, seq: 1 })).not.toBe(checksumOf(event));
	});

	it("verifies a well formed stored event", () => {
		expect(verifyChecksum({ ...event, checksum: checksumOf(event) })).toBe(true);
	});

	it("rejects a stored event whose payload was edited after the fact", () => {
		const tampered = { ...event, checksum: checksumOf(event), payload: { path: "other.ts" } };
		expect(verifyChecksum(tampered)).toBe(false);
	});
});
