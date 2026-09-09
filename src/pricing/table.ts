import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PricingTable } from "./cost.js";

export const EMPTY_PRICING: PricingTable = { version: 1, rates: {} };

export async function loadPricing(rptDir: string): Promise<PricingTable> {
	try {
		return JSON.parse(await readFile(join(rptDir, "pricing.json"), "utf8")) as PricingTable;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_PRICING;
		throw new Error(`.rpt/pricing.json is unreadable: ${(error as Error).message}`);
	}
}
