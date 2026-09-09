import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
