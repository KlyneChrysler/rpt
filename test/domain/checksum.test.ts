import { describe, expect, it } from "vitest";
import { canonicalize, checksumOf, fingerprintOf, verifyChecksum } from "../../src/domain/checksum.js";
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

describe("validation: non-JSON-plain values throw", () => {
	it("throws on Date in payload and names the path", () => {
		const withDate = { ...event, payload: { startedAt: new Date() } };
		expect(() => canonicalize(withDate)).toThrow(/payload\.startedAt: found Date/);
	});

	it("throws on undefined in payload", () => {
		const withUndefined = { ...event, payload: { value: undefined } };
		expect(() => canonicalize(withUndefined)).toThrow(/payload\.value: found undefined/);
	});

	it("throws on NaN in payload", () => {
		const withNaN = { ...event, payload: { value: NaN } };
		expect(() => canonicalize(withNaN)).toThrow(/payload\.value: found NaN/);
	});

	it("throws on function in payload", () => {
		const withFunction = { ...event, payload: { fn: () => {} } };
		expect(() => canonicalize(withFunction)).toThrow(/payload\.fn: found function/);
	});

	it("throws on nested bad value and names full path", () => {
		const nested = { ...event, payload: { outer: { inner: new Date() } } };
		expect(() => canonicalize(nested)).toThrow(/payload\.outer\.inner: found Date/);
	});

	it("accepts JSON-plain values in payload", () => {
		const plain = {
			...event,
			payload: {
				string: "text",
				number: 42,
				boolean: true,
				null: null,
				array: [1, "two"],
				object: { a: 1, b: 2 },
			},
		};
		expect(() => canonicalize(plain)).not.toThrow();
	});
});

describe("arrays", () => {
	it("normalizes keys in array of objects while preserving element order", () => {
		const withKeys1 = {
			...event,
			payload: { items: [{ b: 2, a: 1 }] },
		};
		const withKeys2 = {
			...event,
			payload: { items: [{ a: 1, b: 2 }] },
		};
		expect(canonicalize(withKeys1)).toBe(canonicalize(withKeys2));
	});

	it("changes canonical form when array element order changes", () => {
		const order1 = {
			...event,
			payload: { items: [{ x: 1 }, { x: 2 }] },
		};
		const order2 = {
			...event,
			payload: { items: [{ x: 2 }, { x: 1 }] },
		};
		expect(canonicalize(order1)).not.toBe(canonicalize(order2));
	});
});

describe("fingerprintOf", () => {
	it("is deterministic for the same value", () => {
		const value = { thresholds: { review: 21, approval: 51, block: 81 }, ruleOverrides: {} };
		expect(fingerprintOf(value)).toBe(fingerprintOf(value));
	});

	it("is insensitive to key order, the same way canonicalize is", () => {
		expect(fingerprintOf({ a: 1, b: 2 })).toBe(fingerprintOf({ b: 2, a: 1 }));
	});

	it("changes when the value changes", () => {
		expect(fingerprintOf({ block: 81 })).not.toBe(fingerprintOf({ block: 82 }));
	});
});
