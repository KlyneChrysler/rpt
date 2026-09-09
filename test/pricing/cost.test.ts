import { describe, expect, it } from "vitest";
import type { ModelUsage } from "../../src/domain/run.js";
import { costOf, type PricingTable } from "../../src/pricing/cost.js";

const usage: ModelUsage[] = [
	{ model: "model-a", input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreate: 0 },
];

const table: PricingTable = {
	version: 1,
	rates: { "model-a": { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 } },
};

describe("costOf", () => {
	it("prices a million input and a million output tokens at their rates", () => {
		expect(costOf(usage, table)).toEqual({ usd: 18, unpriced: [] });
	});

	it("sums across messages", () => {
		expect(costOf([...usage, ...usage], table).usd).toBe(36);
	});

	it("returns null and names the model when a rate is missing", () => {
		const result = costOf([{ ...usage[0]!, model: "model-b" }], table);
		expect(result).toEqual({ usd: null, unpriced: ["model-b"] });
	});

	it("returns null when a rate is explicitly null rather than guessing", () => {
		const partial: PricingTable = {
			version: 1,
			rates: { "model-a": { input: null, output: 15, cacheRead: 0.3, cacheCreate: 3.75 } },
		};
		expect(costOf(usage, partial).usd).toBeNull();
	});

	it("is zero for a run with no usage at all", () => {
		expect(costOf([], table)).toEqual({ usd: 0, unpriced: [] });
	});

	// A rate object is untrusted data (typically hand-edited JSON), not something
	// the type system actually guarantees the shape of at runtime - these cast
	// past the compiler the way a JSON.parse result would arrive.
	it("returns null and names the model when a rate object is missing one key", () => {
		const missingCacheCreate = {
			version: 1,
			rates: { "model-a": { input: 3, output: 15, cacheRead: 0.3 } },
		} as unknown as PricingTable;
		expect(costOf(usage, missingCacheCreate)).toEqual({ usd: null, unpriced: ["model-a"] });
	});

	it("returns null and names the model when a rate object is missing several keys", () => {
		const onlyInput = {
			version: 1,
			rates: { "model-a": { input: 3 } },
		} as unknown as PricingTable;
		expect(costOf(usage, onlyInput)).toEqual({ usd: null, unpriced: ["model-a"] });
	});

	it("returns null and names the model when a rate object carries an extra unknown key", () => {
		const withExtraKey = {
			version: 1,
			rates: { "model-a": { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75, cacheWrite: 9 } },
		} as unknown as PricingTable;
		expect(costOf(usage, withExtraKey)).toEqual({ usd: null, unpriced: ["model-a"] });
	});

	it("returns null and names the model when a rate is negative", () => {
		const negative = {
			version: 1,
			rates: { "model-a": { input: -3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 } },
		} as unknown as PricingTable;
		expect(costOf(usage, negative)).toEqual({ usd: null, unpriced: ["model-a"] });
	});

	it("returns null and names the model when a rate is not finite", () => {
		const infinite = {
			version: 1,
			rates: { "model-a": { input: Number.POSITIVE_INFINITY, output: 15, cacheRead: 0.3, cacheCreate: 3.75 } },
		} as unknown as PricingTable;
		expect(costOf(usage, infinite)).toEqual({ usd: null, unpriced: ["model-a"] });
	});

	it("returns null and names the model when a rate value is not a number", () => {
		const stringRate = {
			version: 1,
			rates: { "model-a": { input: "3", output: 15, cacheRead: 0.3, cacheCreate: 3.75 } },
		} as unknown as PricingTable;
		expect(costOf(usage, stringRate)).toEqual({ usd: null, unpriced: ["model-a"] });
	});
});
