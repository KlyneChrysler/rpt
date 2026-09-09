import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ratesSchema, type PricingTable } from "./cost.js";

export const EMPTY_PRICING: PricingTable = { version: 1, rates: {} };

// Only the outer envelope is required to be well-formed; each model's rates
// are validated individually below so one bad entry doesn't take the whole
// file down.
const pricingFileSchema = z.object({
	version: z.number(),
	rates: z.record(z.string(), z.unknown()),
});

export async function loadPricing(rptDir: string): Promise<PricingTable> {
	try {
		const text = await readFile(join(rptDir, "pricing.json"), "utf8");
		return parsePricing(text);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_PRICING;
		throw new Error(`.rpt/pricing.json is unreadable: ${(error as Error).message}`);
	}
}

// Never casts the parsed JSON to PricingTable and trusts it: a hand-edited
// file is exactly where a rate entry is missing a key, has an extra key, or
// holds a non-numeric value, and that must come out unpriced rather than
// pass silently into cost math. A malformed model entry is dropped (and
// traced to stderr) rather than failing the whole file - other, well-formed
// models must still price normally.
function parsePricing(text: string): PricingTable {
	const raw = pricingFileSchema.parse(JSON.parse(text));
	return { version: raw.version, rates: validRatesOnly(raw.rates) };
}

function validRatesOnly(rawRates: Record<string, unknown>): PricingTable["rates"] {
	const rates: PricingTable["rates"] = {};
	for (const [model, candidate] of Object.entries(rawRates)) {
		const parsed = ratesSchema.safeParse(candidate);
		if (parsed.success) {
			rates[model] = parsed.data;
		} else {
			process.stderr.write(
				`rpt: .rpt/pricing.json: rate entry for "${model}" is malformed and will be treated as unpriced\n`,
			);
		}
	}
	return rates;
}
