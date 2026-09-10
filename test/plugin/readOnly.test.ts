import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const COMMANDS = join("plugin", "commands");

async function commandBodies(): Promise<string[]> {
	const files = await readdir(COMMANDS);
	return Promise.all(files.map((file) => readFile(join(COMMANDS, file), "utf8")));
}

describe("the agent surface is read only", () => {
	it("ships exactly the four read-only commands", async () => {
		expect((await readdir(COMMANDS)).sort()).toEqual(["diff.md", "risk.md", "status.md", "verify.md"]);
	});

	it("never invokes approve or reject", async () => {
		for (const body of await commandBodies()) {
			expect(body).not.toMatch(/rpt\s+(approve|reject)/);
		}
	});

	it("never sets the bypass variable", async () => {
		for (const body of await commandBodies()) {
			expect(body).not.toMatch(/RPT_BYPASS=/);
		}
	});

	it("always requests the agent output format", async () => {
		for (const body of await commandBodies()) {
			expect(body).toContain("--format=agent");
		}
	});

	it("restricts each command to rpt invocations only", async () => {
		for (const body of await commandBodies()) {
			const allowed = /^allowed-tools:\s*(.+)$/m.exec(body)?.[1] ?? "";
			expect(allowed).toMatch(/^Bash\(rpt /);
		}
	});

	it("tells the agent whose record this is on every command", async () => {
		for (const body of await commandBodies()) {
			expect(body).toContain("You cannot approve or clear a run.");
		}
	});

	it("declares a plugin manifest with a name and version", async () => {
		const manifest = JSON.parse(await readFile(join("plugin", ".claude-plugin", "plugin.json"), "utf8"));
		expect(typeof manifest.name).toBe("string");
		expect(typeof manifest.version).toBe("string");
	});

	// The marketplace manifest is what makes `claude plugin marketplace add
	// KlyneChrysler/rpt` work at all. A version that drifts from the plugin's
	// own installs the wrong thing, silently.
	it("ships a marketplace manifest whose entry agrees with the plugin", async () => {
		const marketplace = JSON.parse(await readFile(join(".claude-plugin", "marketplace.json"), "utf8"));
		const plugin = JSON.parse(await readFile(join("plugin", ".claude-plugin", "plugin.json"), "utf8"));
		const entry = marketplace.plugins.find((candidate: { name: string }) => candidate.name === plugin.name);
		expect(entry).toBeDefined();
		expect(entry.version).toBe(plugin.version);
		expect(entry.source).toBe("./plugin");
	});

	it("keeps the plugin version in step with the package version", async () => {
		const manifest = JSON.parse(await readFile(join("plugin", ".claude-plugin", "plugin.json"), "utf8"));
		const pkg = JSON.parse(await readFile("package.json", "utf8"));
		expect(manifest.version).toBe(pkg.version);
	});
});
