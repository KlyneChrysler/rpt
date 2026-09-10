import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const UI_DIR = join("src", "ui");

// Anything the Ink layer is allowed to reach for. The point of the list is not
// that these are safe imports in the abstract - it is that replacing Ink with
// another surface must touch src/ui and nothing else, which stops being true
// the moment a component reads a file, shells out to git, or knows how a run
// is stored.
const ALLOWED_BARE = new Set(["ink", "react"]);
const ALLOWED_PREFIXES = ["../app/", "../../app/", "./", "../components/", "../screens/", "../theme.js"];
// One named exception, not a whole layer: src/domain/duration.ts formats two
// instants and imports nothing whatsoever, so it cannot smuggle storage, git
// or I/O into the console the way a general "../../domain/" permission could.
// Both surfaces render a run's duration, and duplicating that arithmetic is
// how two screens come to disagree about how long the same run took.
const ALLOWED_FILES = new Set(["../../domain/duration.js"]);
// Type-only imports carry no runtime dependency at all: they vanish at
// compile time, so they cannot pull the store or git into a browser bundle.
const TYPE_ONLY = /^import\s+type\b/;

const IMPORT_RE = /^\s*import\s+(?:type\s+)?[^"']*from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;

async function uiFiles(dir = UI_DIR): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await uiFiles(path)));
		else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push(path);
	}
	return files;
}

type Import = { file: string; specifier: string; typeOnly: boolean };

async function uiImports(): Promise<Import[]> {
	const imports: Import[] = [];
	for (const file of await uiFiles()) {
		const source = await readFile(file, "utf8");
		for (const line of source.split("\n")) {
			IMPORT_RE.lastIndex = 0;
			const match = IMPORT_RE.exec(line);
			const specifier = match?.[1] ?? match?.[2];
			if (specifier !== undefined) imports.push({ file, specifier, typeOnly: TYPE_ONLY.test(line) });
		}
	}
	return imports;
}

function isAllowed(entry: Import): boolean {
	if (entry.typeOnly) return true;
	if (ALLOWED_BARE.has(entry.specifier)) return true;
	if (ALLOWED_FILES.has(entry.specifier)) return true;
	return ALLOWED_PREFIXES.some((prefix) => entry.specifier.startsWith(prefix));
}

describe("the ui layer imports only from app", () => {
	it("never reaches into store, git, verifiers, risk, config or the daemon at runtime", async () => {
		const offenders = (await uiImports()).filter((entry) => !isAllowed(entry));
		expect(offenders.map((entry) => `${entry.file} -> ${entry.specifier}`)).toEqual([]);
	});

	it("performs no i/o of its own", async () => {
		const nodeImports = (await uiImports()).filter((entry) => entry.specifier.startsWith("node:") && !entry.typeOnly);
		expect(nodeImports.map((entry) => `${entry.file} -> ${entry.specifier}`)).toEqual([]);
	});
});
