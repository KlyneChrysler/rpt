import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { configSchema, type RptConfig } from "./schema.js";

export const DEFAULT_CONFIG: RptConfig = configSchema.parse({});

export async function loadConfig(repoRoot: string): Promise<RptConfig> {
	const raw = await readRawConfig(join(repoRoot, "rpt.config.json"));
	if (raw === null) return DEFAULT_CONFIG;
	const parsed = configSchema.safeParse(raw);
	if (!parsed.success) throw new Error(describeConfigFailure(parsed.error));
	return parsed.data;
}

async function readRawConfig(path: string): Promise<unknown | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch (error) {
		if (isMissingFile(error)) return null;
		throw new Error(`rpt.config.json is unreadable: ${(error as Error).message}`);
	}
}

function isMissingFile(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function describeConfigFailure(error: z.ZodError): string {
	const issues = error.issues.map((issue) => {
		const path = issue.path.join(".") || "root";
		if (issue.code === "unrecognized_keys") {
			return `unknown key ${issue.keys.join(", ")} at ${path}`;
		}
		return `${path}: ${issue.message}`;
	});
	return `rpt.config.json is invalid\n  ${issues.join("\n  ")}`;
}
