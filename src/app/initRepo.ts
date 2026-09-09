import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installHooks } from "../collectors/claudeCodeHooks.js";
import { DEFAULT_CONFIG } from "../config/load.js";
import { rptDirOf } from "../store/paths.js";

export type InitReport = {
	hooksInstalled: boolean;
	gitignoreUpdated: boolean;
	configCreated: boolean;
	pricingCreated: boolean;
};

// `rpt init` installs agent hooks only. Git hooks and the commit gate belong
// to a later plan and are not added here.
export async function initRepo(repoRoot: string): Promise<InitReport> {
	await mkdir(rptDirOf(repoRoot), { recursive: true });
	await installHooks(repoRoot);
	return {
		hooksInstalled: true,
		gitignoreUpdated: await ensureIgnored(repoRoot),
		configCreated: await createIfAbsent(join(repoRoot, "rpt.config.json"), configTemplate()),
		pricingCreated: await createIfAbsent(join(rptDirOf(repoRoot), "pricing.json"), pricingTemplate()),
	};
}

function configTemplate(): string {
	// DEFAULT_CONFIG's nested objects are shared references reused by every
	// caller - JSON.stringify only reads them, so this is safe without cloning.
	return `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
}

function pricingTemplate(): string {
	// rpt does not know model prices and must not guess them: an empty rates
	// object is the correct and honest output, not a placeholder to fill in later.
	return `${JSON.stringify({ version: 1, rates: {} }, null, 2)}\n`;
}

async function ensureIgnored(repoRoot: string): Promise<boolean> {
	const path = join(repoRoot, ".gitignore");
	const current = await readOrEmpty(path);
	if (current.split("\n").includes(".rpt/")) return false;
	const separator = current === "" || current.endsWith("\n") ? "" : "\n";
	await writeFile(path, `${current}${separator}.rpt/\n`, "utf8");
	return true;
}

async function createIfAbsent(path: string, body: string): Promise<boolean> {
	try {
		await writeFile(path, body, { flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

async function readOrEmpty(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}
