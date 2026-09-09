import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { costOf } from "../../src/pricing/cost.js";
import { EMPTY_PRICING, loadPricing } from "../../src/pricing/table.js";
import { pricingFileOf } from "../../src/store/paths.js";

let rptDir = "";

const goodRates = { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 };

beforeEach(async () => {
	rptDir = await mkdtemp(join(tmpdir(), "rpt-pricing-"));
});

async function writePricing(body: string): Promise<void> {
	await writeFile(pricingFileOf(rptDir), body, "utf8");
}

async function loadQuietly(): Promise<Awaited<ReturnType<typeof loadPricing>>> {
	const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		return await loadPricing(rptDir);
	} finally {
		spy.mockRestore();
	}
}

describe("loadPricing", () => {
	// rpt ships no rates and refuses to guess any, so no file at all is the normal
	// state, not an error - it means every model is unpriced, which costOf already
	// reports as null rather than zero.
	it("is the empty table when there is no pricing file", async () => {
		expect(await loadPricing(rptDir)).toEqual(EMPTY_PRICING);
	});

	it("reads a well-formed file", async () => {
		await writePricing(JSON.stringify({ version: 1, rates: { "model-a": goodRates } }));
		expect(await loadPricing(rptDir)).toEqual({ version: 1, rates: { "model-a": goodRates } });
	});

	it("fails loudly when the file is not JSON at all", async () => {
		await writePricing("{ not json");
		await expect(loadPricing(rptDir)).rejects.toThrow(/unreadable/i);
	});

	it("fails loudly when the envelope has no rates object", async () => {
		await writePricing(JSON.stringify({ version: 1 }));
		await expect(loadPricing(rptDir)).rejects.toThrow(/unreadable/i);
	});

	it("fails loudly when the envelope has no version", async () => {
		await writePricing(JSON.stringify({ rates: {} }));
		await expect(loadPricing(rptDir)).rejects.toThrow(/unreadable/i);
	});

	// One hand-edited entry must not take the whole file down: the other models
	// still price correctly, and the bad one comes out unpriced rather than
	// half-priced against whichever keys happened to survive.
	it("keeps the good entries and drops one malformed entry among them", async () => {
		await writePricing(
			JSON.stringify({
				version: 1,
				rates: { good: goodRates, bad: { input: 3 }, alsoGood: goodRates },
			}),
		);

		const table = await loadQuietly();

		expect(Object.keys(table.rates).sort()).toEqual(["alsoGood", "good"]);
	});

	it("traces the model it dropped rather than dropping it in silence", async () => {
		await writePricing(JSON.stringify({ version: 1, rates: { bad: { input: "3" } } }));
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			await loadPricing(rptDir);
			expect(spy.mock.calls.some((call) => String(call[0]).includes("bad"))).toBe(true);
		} finally {
			spy.mockRestore();
		}
	});

	// A negative rate yields a plausible-looking negative cost, which is the same
	// class of defect as a missing key silently pricing at zero.
	it("drops an entry carrying a negative rate", async () => {
		await writePricing(JSON.stringify({ version: 1, rates: { "model-a": { ...goodRates, input: -3 } } }));
		expect(await loadQuietly()).toEqual(EMPTY_PRICING);
	});

	it("drops an entry carrying a non-finite rate", async () => {
		await writePricing(`{"version":1,"rates":{"model-a":{"input":1e999,"output":15,"cacheRead":0.3,"cacheCreate":3.75}}}`);
		expect(await loadQuietly()).toEqual(EMPTY_PRICING);
	});

	// The point of the whole path: a dropped entry reaches costOf as an absent
	// rate, and costOf reports no cost rather than an invented one.
	it("leaves a dropped model unpriced all the way through to costOf", async () => {
		await writePricing(JSON.stringify({ version: 1, rates: { "model-a": { input: -3 } } }));

		const table = await loadQuietly();

		expect(costOf([{ model: "model-a", input: 10, output: 0, cacheRead: 0, cacheCreate: 0 }], table)).toEqual({
			usd: null,
			unpriced: ["model-a"],
		});
	});
});
