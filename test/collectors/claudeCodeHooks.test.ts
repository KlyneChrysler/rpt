import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installHooks, uninstallHooks } from "../../src/collectors/claudeCodeHooks.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

const NON_OBJECT_SHAPES: [string, string][] = [
	["an array", "[]"],
	["a bare string", "\"just a string\""],
	["a number", "42"],
	["null", "null"],
];

function settingsPath(repo: string): string {
	return join(repo, ".claude", "settings.json");
}

async function writeSettings(repo: string, body: string): Promise<void> {
	await mkdir(join(repo, ".claude"), { recursive: true });
	await writeFile(settingsPath(repo), body, "utf8");
}

async function readSettingsRaw(repo: string): Promise<string> {
	return readFile(settingsPath(repo), "utf8");
}

describe("installHooks", () => {
	it("preserves a pre-existing hook and unrelated top-level keys", async () => {
		const repo = await makeFixtureRepo();
		await writeSettings(
			repo,
			JSON.stringify({
				hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "someone-elses-hook" }] }] },
				permissions: { allow: ["Bash(git status:*)"] },
				env: { FOO: "bar" },
			}),
		);

		await installHooks(repo);

		const settings = JSON.parse(await readSettingsRaw(repo));
		const commands = JSON.stringify(settings.hooks.PreToolUse);
		expect(commands).toContain("someone-elses-hook");
		expect(commands).toContain("rpt hook");
		expect(settings.permissions).toEqual({ allow: ["Bash(git status:*)"] });
		expect(settings.env).toEqual({ FOO: "bar" });
	});

	it.each(NON_OBJECT_SHAPES)(
		"refuses to overwrite and writes nothing when settings.json parses to %s",
		async (_label, malformed) => {
			const repo = await makeFixtureRepo();
			await writeSettings(repo, malformed);

			await expect(installHooks(repo)).rejects.toThrow();

			expect(await readSettingsRaw(repo)).toBe(malformed);
		},
	);
});

describe("uninstallHooks", () => {
	it("removes only the rpt hook, preserving a pre-existing hook and unrelated top-level keys", async () => {
		const repo = await makeFixtureRepo();
		await writeSettings(
			repo,
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{ matcher: "Bash", hooks: [{ type: "command", command: "someone-elses-hook" }] },
						{ hooks: [{ type: "command", command: "rpt hook" }] },
					],
				},
				permissions: { allow: ["Bash(git status:*)"] },
				env: { FOO: "bar" },
			}),
		);

		await uninstallHooks(repo);

		const settings = JSON.parse(await readSettingsRaw(repo));
		const commands = JSON.stringify(settings.hooks.PreToolUse);
		expect(commands).toContain("someone-elses-hook");
		expect(commands).not.toContain("rpt hook");
		expect(settings.permissions).toEqual({ allow: ["Bash(git status:*)"] });
		expect(settings.env).toEqual({ FOO: "bar" });
	});

	it.each(NON_OBJECT_SHAPES)(
		"refuses to overwrite and writes nothing when settings.json parses to %s",
		async (_label, malformed) => {
			const repo = await makeFixtureRepo();
			await writeSettings(repo, malformed);

			await expect(uninstallHooks(repo)).rejects.toThrow();

			expect(await readSettingsRaw(repo)).toBe(malformed);
		},
	);
});
