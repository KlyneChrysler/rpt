import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Matches `import ... from "specifier"` and `export ... from "specifier"`, including
// type-only and side-effect variants, capturing the quoted specifier.
const FROM_SPECIFIER_RE = /\b(?:import|export)\s+[^;'"]*?\bfrom\s+["']([^"']+)["']/g;
// Matches a bare side-effect import: `import "specifier";`
const BARE_IMPORT_RE = /\bimport\s+["']([^"']+)["']\s*;/g;

function extractSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	for (const match of source.matchAll(FROM_SPECIFIER_RE)) specifiers.push(match[1]!);
	for (const match of source.matchAll(BARE_IMPORT_RE)) specifiers.push(match[1]!);
	return specifiers;
}

/**
 * Enforces that a src/domain file imports nothing outside src/domain and no node:
 * builtin other than node:crypto in checksum.ts (checksum.ts is exempt only for
 * node:crypto, because hashing is a pure computation with no I/O). Same-directory
 * relative imports (./events.js, ./state.js, ...) are allowed; anything that leaves
 * the directory (../...), any node: builtin besides the one exemption, and any
 * third-party bare specifier is rejected.
 */
export function findPurityViolations(filename: string, source: string): string[] {
	return extractSpecifiers(source).flatMap((specifier): string[] => {
		if (specifier.startsWith("./")) return [];
		if (specifier.startsWith("../")) {
			return [`${filename}: relative import leaves src/domain: "${specifier}"`];
		}
		if (specifier.startsWith("node:")) {
			if (filename === "checksum.ts" && specifier === "node:crypto") return [];
			return [`${filename}: forbidden node builtin import: "${specifier}"`];
		}
		return [`${filename}: forbidden third-party import: "${specifier}"`];
	});
}

describe("domain purity", () => {
	it("imports nothing outside src/domain and no forbidden node builtins", async () => {
		const dir = "src/domain";
		for (const file of await readdir(dir)) {
			if (!file.endsWith(".ts")) continue;
			const source = await readFile(join(dir, file), "utf8");
			expect(findPurityViolations(file, source)).toEqual([]);
		}
	});

	it("rejects a relative import that leaves src/domain into ../config", () => {
		const source = `import { loadConfig } from "../config/load.js";`;
		expect(findPurityViolations("run.ts", source)).toEqual([
			'run.ts: relative import leaves src/domain: "../config/load.js"',
		]);
	});

	it("rejects a relative import that leaves src/domain into ../store", () => {
		const source = `import { appendEvent } from "../store/eventLog.js";`;
		expect(findPurityViolations("run.ts", source)).toEqual([
			'run.ts: relative import leaves src/domain: "../store/eventLog.js"',
		]);
	});

	it("rejects node:fs", () => {
		const source = `import { readFile } from "node:fs";`;
		expect(findPurityViolations("run.ts", source)).toEqual(['run.ts: forbidden node builtin import: "node:fs"']);
	});

	it("accepts a same-directory relative import", () => {
		const source = `import type { AgentEvent } from "./events.js";`;
		expect(findPurityViolations("run.ts", source)).toEqual([]);
	});

	it("accepts node:crypto in checksum.ts", () => {
		const source = `import { createHash } from "node:crypto";`;
		expect(findPurityViolations("checksum.ts", source)).toEqual([]);
	});

	it("rejects node:crypto in any file other than checksum.ts", () => {
		const source = `import { createHash } from "node:crypto";`;
		expect(findPurityViolations("run.ts", source)).toEqual(['run.ts: forbidden node builtin import: "node:crypto"']);
	});
});
