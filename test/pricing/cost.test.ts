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
});
