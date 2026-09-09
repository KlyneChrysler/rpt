import { mkdir, writeFile } from "node:fs/promises";
import { pricingFileOf, rptDirOf } from "./paths.js";

// rpt does not know model prices and must not guess them: the scaffolded file
// ships with an empty rates object, never invented numbers.
const PRICING_TEMPLATE = `${JSON.stringify({ version: 1, rates: {} }, null, 2)}\n`;

export async function createPricingFileIfAbsent(repoRoot: string): Promise<boolean> {
	const rptDir = rptDirOf(repoRoot);
	await mkdir(rptDir, { recursive: true });
	try {
		await writeFile(pricingFileOf(rptDir), PRICING_TEMPLATE, { flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}
