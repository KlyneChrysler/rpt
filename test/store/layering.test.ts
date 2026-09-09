import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Spec section 5: only src/store writes to .rpt. Building the path is the first
// step of that write, so the rule is enforced on the path literal rather than on
// the filesystem call - a module that knows where .rpt keeps its files already
// owns a decision the store layer is supposed to own alone. Naming one of these
// files in prose (an error message, a .gitignore line) is not path building, so
// only a literal inside a join() call counts.
const JOIN_CALL_RE = /\bjoin\s*\(([^)]*)\)/g;
const RPT_INTERNAL_LITERAL_RE = /["'](\.rpt|daemon\.sock|index\.jsonl|events\.jsonl|pricing\.json|current|start-failures\.jsonl)["']/;

export function findRptPathViolations(relativePath: string, source: string): string[] {
	if (relativePath.startsWith("store/")) return [];
	return [...source.matchAll(JOIN_CALL_RE)]
		.filter((match) => RPT_INTERNAL_LITERAL_RE.test(match[1]!))
		.map((match) => `${relativePath}: builds an .rpt path outside the store layer: join(${match[1]!})`);
}

async function sourceFiles(dir: string, prefix = ""): Promise<{ path: string; source: string }[]> {
	const found: { path: string; source: string }[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const relative = `${prefix}${entry.name}`;
		if (entry.isDirectory()) found.push(...(await sourceFiles(join(dir, entry.name), `${relative}/`)));
		else if (entry.name.endsWith(".ts")) found.push({ path: relative, source: await readFile(join(dir, entry.name), "utf8") });
	}
	return found;
}

describe("store owns every path under .rpt", () => {
	it("finds no module outside src/store building one", async () => {
		const violations = (await sourceFiles("src")).flatMap((file) => findRptPathViolations(file.path, file.source));
		expect(violations).toEqual([]);
	});

	it("flags a daemon that knows where the socket lives", () => {
		const source = `return join(rptDir, "daemon.sock");`;
		expect(findRptPathViolations("daemon/protocol.ts", source)).toHaveLength(1);
	});

	it("allows the store layer itself to build one", () => {
		const source = `return join(rptDir, "index.jsonl");`;
		expect(findRptPathViolations("store/paths.ts", source)).toEqual([]);
	});

	it("does not mistake an error message naming a file for path building", () => {
		const source = `throw new Error(".rpt/pricing.json is unreadable");`;
		expect(findRptPathViolations("pricing/table.ts", source)).toEqual([]);
	});
});
