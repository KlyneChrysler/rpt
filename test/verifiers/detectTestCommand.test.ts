import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectTestCommand } from "../../src/verifiers/detectTestCommand.js";

async function treeWith(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "rpt-detect-"));
	for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
	return dir;
}

describe("detectTestCommand", () => {
	it("uses the package.json test script when present", async () => {
		const dir = await treeWith({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });
		expect(await detectTestCommand(dir)).toBe("npm test");
	});

	it("prefers pnpm when a pnpm lockfile is present", async () => {
		const dir = await treeWith({
			"package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
			"pnpm-lock.yaml": "lockfileVersion: 9.0\n",
		});
		expect(await detectTestCommand(dir)).toBe("pnpm test");
	});

	it("detects go", async () => {
		expect(await detectTestCommand(await treeWith({ "go.mod": "module x\n" }))).toBe("go test ./...");
	});

	it("detects cargo", async () => {
		expect(await detectTestCommand(await treeWith({ "Cargo.toml": "[package]\n" }))).toBe("cargo test");
	});

	it("detects python projects that declare pytest", async () => {
		const dir = await treeWith({ "pyproject.toml": "[tool.pytest.ini_options]\n" });
		expect(await detectTestCommand(dir)).toBe("pytest");
	});

	it("returns null when nothing is recognisable", async () => {
		expect(await detectTestCommand(await treeWith({ "readme.txt": "hi" }))).toBeNull();
	});

	it("returns null for a package.json with no test script", async () => {
		const dir = await treeWith({ "package.json": JSON.stringify({ scripts: { build: "tsc" } }) });
		expect(await detectTestCommand(dir)).toBeNull();
	});
});
