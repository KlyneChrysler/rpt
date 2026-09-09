import type { ModelUsage } from "../domain/run.js";

export type Rates = {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheCreate: number | null;
};

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

function isPriced(entry: ModelUsage, table: PricingTable): boolean {
	const rates = table.rates[entry.model];
	if (rates === undefined) return false;
	return Object.values(rates).every((rate) => rate !== null);
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
