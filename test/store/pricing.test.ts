import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { costOf } from "../../src/pricing/cost.js";
import { createPricingFileIfAbsent } from "../../src/store/pricing.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

describe("createPricingFileIfAbsent", () => {
	it("creates the .rpt directory and a pricing file with no invented rates", async () => {
		const repo = await makeFixtureRepo();

		const created = await createPricingFileIfAbsent(repo);

		expect(created).toBe(true);
		const stats = await stat(join(repo, ".rpt"));
		expect(stats.isDirectory()).toBe(true);
		const pricing = JSON.parse(await readFile(join(repo, ".rpt/pricing.json"), "utf8"));
		expect(pricing).toEqual({ version: 1, rates: {} });
	});

	it("seeds the models it is given, at explicit null rates, never at invented ones", async () => {
		const repo = await makeFixtureRepo();

		await createPricingFileIfAbsent(repo, ["claude-opus-5", "claude-haiku-4-5-20251001"]);

		const pricing = JSON.parse(await readFile(join(repo, ".rpt/pricing.json"), "utf8"));
		expect(pricing.rates["claude-opus-5"]).toEqual({ input: null, output: null, cacheRead: null, cacheCreate: null });
		expect(Object.keys(pricing.rates)).toHaveLength(2);
	});

	it("leaves a seeded model reporting no cost, the same as a missing one", async () => {
		const repo = await makeFixtureRepo();
		await createPricingFileIfAbsent(repo, ["claude-opus-5"]);
		const table = JSON.parse(await readFile(join(repo, ".rpt/pricing.json"), "utf8"));
		const usage = [{ model: "claude-opus-5", input: 100, output: 100, cacheRead: 0, cacheCreate: 0 }];

		expect(costOf(usage, table)).toEqual({ usd: null, unpriced: ["claude-opus-5"] });
	});

	it("is idempotent and never overwrites an existing pricing file", async () => {
		const repo = await makeFixtureRepo();
		await createPricingFileIfAbsent(repo);
		await writeFile(join(repo, ".rpt/pricing.json"), JSON.stringify({ version: 1, rates: { "gpt-4": 1 } }));

		const created = await createPricingFileIfAbsent(repo);

		expect(created).toBe(false);
		const pricing = JSON.parse(await readFile(join(repo, ".rpt/pricing.json"), "utf8"));
		expect(pricing.rates).toEqual({ "gpt-4": 1 });
	});
});
