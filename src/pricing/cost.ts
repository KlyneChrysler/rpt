import { z } from "zod";
import type { ModelUsage } from "../domain/run.js";

// The exact, closed shape of one model's rates: all four fields required (a
// missing field is not "unpriced for that field", it is a malformed entry),
// each either a real per-million-token rate or an explicit null meaning
// "known to be unknown, don't guess" - and no other fields tolerated, so a
// typo'd key doesn't quietly ride along as an ignored extra while the field
// it was meant to set is treated as missing.
//
// A rate is also finite and not negative. A negative rate is the same class of
// defect as a missing key priced at zero: it produces a plausible-looking number
// (a negative cost, or Infinity) instead of refusing, and a plausible wrong number
// is worse than no number at all. Out of range means malformed, so the model comes
// out unpriced.
const rateSchema = z.number().finite().nonnegative().nullable();

export const ratesSchema = z
	.object({
		input: rateSchema,
		output: rateSchema,
		cacheRead: rateSchema,
		cacheCreate: rateSchema,
	})
	.strict();

export type Rates = z.infer<typeof ratesSchema>;

export type PricingTable = { version: number; rates: Record<string, Rates> };

export type Cost = { usd: number | null; unpriced: string[] };

type TokenTotals = { input: number; output: number; cacheRead: number; cacheCreate: number };

const PER_MILLION = 1_000_000;

// Token counts are summed per model first (exact integer arithmetic - no
// floating point involved), and each model's totals are converted to dollars
// exactly once. That keeps the number of floating point additions bounded by
// the number of distinct models rather than the number of messages, so a run
// with thousands of messages against one model does not accumulate rounding
// drift the way summing a per-message dollar amount would.
export function costOf(usage: readonly ModelUsage[], table: PricingTable): Cost {
	const unpriced = [...new Set(usage.filter((entry) => !isPriced(entry, table)).map((entry) => entry.model))];
	if (unpriced.length > 0) return { usd: null, unpriced };

	const totalsByModel = groupTotalsByModel(usage);
	const usd = [...totalsByModel.entries()].reduce(
		(sum, [model, totals]) => sum + priceModel(totals, table.rates[model]!),
		0,
	);
	return { usd: round(usd), unpriced: [] };
}

// Validates shape, not just presence: table.rates[entry.model] is typed as
// Rates, but nothing upstream guarantees a value read from JSON actually has
// that shape (see loadPricing). A rate object missing a key, carrying an
// extra key, or holding a non-numeric value must fail here rather than let
// `rates.cacheRead ?? 0` in priceModel silently price that class at zero.
function isPriced(entry: ModelUsage, table: PricingTable): boolean {
	const rates = table.rates[entry.model];
	if (rates === undefined) return false;
	const parsed = ratesSchema.safeParse(rates);
	return parsed.success && Object.values(parsed.data).every((rate) => rate !== null);
}

function groupTotalsByModel(usage: readonly ModelUsage[]): Map<string, TokenTotals> {
	const totals = new Map<string, TokenTotals>();
	for (const entry of usage) {
		const running = totals.get(entry.model) ?? { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
		totals.set(entry.model, {
			input: running.input + entry.input,
			output: running.output + entry.output,
			cacheRead: running.cacheRead + entry.cacheRead,
			cacheCreate: running.cacheCreate + entry.cacheCreate,
		});
	}
	return totals;
}

function priceModel(totals: TokenTotals, rates: Rates): number {
	return (
		(totals.input * (rates.input ?? 0) +
			totals.output * (rates.output ?? 0) +
			totals.cacheRead * (rates.cacheRead ?? 0) +
			totals.cacheCreate * (rates.cacheCreate ?? 0)) /
		PER_MILLION
	);
}

function round(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}
