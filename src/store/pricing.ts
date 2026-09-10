import { mkdir, writeFile } from "node:fs/promises";
import type { Rates } from "../pricing/cost.js";
import { pricingFileOf, rptDirOf } from "./paths.js";

// rpt does not know model prices and must not guess them. What it can do
// without guessing is name the models this repository actually used, so a user
// filling the file in is editing a list rather than compiling one - a model id
// is not something anybody remembers, and an empty object gives no hint that
// one is even needed. Every seeded rate is an explicit null, which costOf reads
// as "known to be unknown" and reports as no cost.
const UNPRICED: Rates = { input: null, output: null, cacheRead: null, cacheCreate: null };

export async function createPricingFileIfAbsent(repoRoot: string, models: readonly string[] = []): Promise<boolean> {
	const rptDir = rptDirOf(repoRoot);
	await mkdir(rptDir, { recursive: true });
	try {
		await writeFile(pricingFileOf(rptDir), templateFor(models), { flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

function templateFor(models: readonly string[]): string {
	const rates = Object.fromEntries(models.map((model) => [model, UNPRICED]));
	return `${JSON.stringify({ version: 1, rates }, null, 2)}\n`;
}
