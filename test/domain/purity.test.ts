import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Matches `import ... from "specifier"` and `export ... from "specifier"`, including
// type-only and side-effect variants, capturing the quoted specifier.
const FROM_SPECIFIER_RE = /\b(?:import|export)\s+[^;'"]*?\bfrom\s+["']([^"']+)["']/g;
// Same as above, but also captures whether the statement is a whole-statement
// type-only import/export (`import type { X } from "..."` /
// `export type { X } from "..."`), used by the src/risk rule below.
const FROM_SPECIFIER_WITH_KIND_RE = /\b(?:import|export)\s+(type\s+)?[^;'"]*?\bfrom\s+["']([^"']+)["']/g;
// Matches a bare side-effect import: `import "specifier";`
const BARE_IMPORT_RE = /\bimport\s+["']([^"']+)["']\s*;/g;

function extractSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	for (const match of source.matchAll(FROM_SPECIFIER_RE)) specifiers.push(match[1]!);
	for (const match of source.matchAll(BARE_IMPORT_RE)) specifiers.push(match[1]!);
	return specifiers;
}

function extractRiskImports(source: string): Array<{ specifier: string; typeOnly: boolean }> {
	const imports: Array<{ specifier: string; typeOnly: boolean }> = [];
	for (const match of source.matchAll(FROM_SPECIFIER_WITH_KIND_RE)) {
		imports.push({ specifier: match[2]!, typeOnly: match[1] !== undefined });
	}
	for (const match of source.matchAll(BARE_IMPORT_RE)) imports.push({ specifier: match[1]!, typeOnly: false });
	return imports;
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

// src/risk cannot be governed by the domain rule verbatim: it legitimately
// imports picomatch (a pure glob matcher, no I/O) and type-only declarations
// from src/domain and src/config - it needs their shapes, not their code.
// So: same-directory imports are free; a relative import that leaves
// src/risk is allowed only into ../domain or ../config, and only as a
// whole-statement type-only import (a value import would pull in real
// behaviour from another layer, which is exactly what this guard exists to
// stop); "picomatch" is the one allowed bare specifier; every node: builtin
// is forbidden (src/risk has no legitimate reason to touch fs, child
// processes, or the network); and every other third-party or cross-layer
// import is rejected.
const RISK_ALLOWED_PACKAGES = new Set(["picomatch"]);
const RISK_TYPE_ONLY_LAYERS = ["../domain/", "../config/"];

export function findRiskPurityViolations(filename: string, source: string): string[] {
	return extractRiskImports(source).flatMap(({ specifier, typeOnly }): string[] => {
		if (specifier.startsWith("./")) return [];
		if (specifier.startsWith("../")) {
			const layer = RISK_TYPE_ONLY_LAYERS.find((prefix) => specifier.startsWith(prefix));
			if (layer === undefined) {
				return [`${filename}: relative import leaves src/risk into a disallowed layer: "${specifier}"`];
			}
			if (!typeOnly) {
				return [`${filename}: value import crosses into ${layer.replace(/^\.\.\//, "").replace(/\/$/, "")}, must be type-only: "${specifier}"`];
			}
			return [];
		}
		if (specifier.startsWith("node:")) return [`${filename}: forbidden node builtin import: "${specifier}"`];
		if (RISK_ALLOWED_PACKAGES.has(specifier)) return [];
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

describe("risk purity", () => {
	it("imports nothing outside src/risk except type-only domain/config and picomatch", async () => {
		const dir = "src/risk";
		for (const file of await readdir(dir)) {
			if (!file.endsWith(".ts")) continue;
			const source = await readFile(join(dir, file), "utf8");
			expect(findRiskPurityViolations(file, source)).toEqual([]);
		}
	});

	it("accepts a same-directory relative import", () => {
		const source = `import type { RunFacts } from "./facts.js";`;
		expect(findRiskPurityViolations("rules.ts", source)).toEqual([]);
	});

	it("accepts picomatch", () => {
		const source = `import picomatch from "picomatch";`;
		expect(findRiskPurityViolations("facts.ts", source)).toEqual([]);
	});

	it("accepts a type-only import from ../domain", () => {
		const source = `import type { VerifierResult } from "../domain/verifierResult.js";`;
		expect(findRiskPurityViolations("facts.ts", source)).toEqual([]);
	});

	it("accepts a type-only import from ../config", () => {
		const source = `import type { RptConfig } from "../config/schema.js";`;
		expect(findRiskPurityViolations("assess.ts", source)).toEqual([]);
	});

	it("rejects a value import from ../domain", () => {
		const source = `import { buildVerdict } from "../domain/verdict.js";`;
		expect(findRiskPurityViolations("assess.ts", source)).toEqual([
			'assess.ts: value import crosses into domain, must be type-only: "../domain/verdict.js"',
		]);
	});

	it("rejects a relative import into an unrelated layer", () => {
		const source = `import { appendEvent } from "../store/eventLog.js";`;
		expect(findRiskPurityViolations("assess.ts", source)).toEqual([
			'assess.ts: relative import leaves src/risk into a disallowed layer: "../store/eventLog.js"',
		]);
	});

	it("rejects node:fs", () => {
		const source = `import { readFile } from "node:fs";`;
		expect(findRiskPurityViolations("assess.ts", source)).toEqual(['assess.ts: forbidden node builtin import: "node:fs"']);
	});

	it("rejects node:child_process", () => {
		const source = `import { exec } from "node:child_process";`;
		expect(findRiskPurityViolations("assess.ts", source)).toEqual(['assess.ts: forbidden node builtin import: "node:child_process"']);
	});

	it("rejects node:net", () => {
		const source = `import { Socket } from "node:net";`;
		expect(findRiskPurityViolations("assess.ts", source)).toEqual(['assess.ts: forbidden node builtin import: "node:net"']);
	});

	it("rejects a third-party package other than picomatch", () => {
		const source = `import { z } from "zod";`;
		expect(findRiskPurityViolations("assess.ts", source)).toEqual(['assess.ts: forbidden third-party import: "zod"']);
	});
});
