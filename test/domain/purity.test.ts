import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN = [/from "node:fs/, /from "node:child_process/, /from "node:net/, /\.\.\/store\//, /\.\.\/git\//];

describe("domain purity", () => {
	it("imports no I/O and no impure modules", async () => {
		const dir = "src/domain";
		for (const file of await readdir(dir)) {
			// checksum.ts is exempt: node:crypto is a pure computation, not I/O.
			if (!file.endsWith(".ts") || file === "checksum.ts") continue;
			const source = await readFile(join(dir, file), "utf8");
			for (const pattern of FORBIDDEN) {
				expect(source, `${file} must stay pure`).not.toMatch(pattern);
			}
		}
	});
});
