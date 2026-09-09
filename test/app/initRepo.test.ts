import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initRepo } from "../../src/app/initRepo.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

async function read(repo: string, path: string): Promise<string> {
	return readFile(join(repo, path), "utf8");
}

describe("initRepo", () => {
	it("registers rpt hook for every collected claude code event", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		const settings = JSON.parse(await read(repo, ".claude/settings.json"));
		expect(Object.keys(settings.hooks).sort()).toEqual(
			["PostToolUse", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"],
		);
	});

	it("preserves hooks that were already configured", async () => {
		const repo = await makeFixtureRepo();
		await mkdir(join(repo, ".claude"), { recursive: true });
		await writeFile(
			join(repo, ".claude/settings.json"),
			JSON.stringify({
				hooks: {
					PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "someone-elses-hook" }] }],
				},
			}),
		);

		await initRepo(repo);

		const settings = JSON.parse(await read(repo, ".claude/settings.json"));
		const commands = JSON.stringify(settings.hooks.PreToolUse);
		expect(commands).toContain("someone-elses-hook");
		expect(commands).toContain("rpt hook");
	});

	it("preserves unrelated top-level settings keys", async () => {
		const repo = await makeFixtureRepo();
		await mkdir(join(repo, ".claude"), { recursive: true });
		await writeFile(
			join(repo, ".claude/settings.json"),
			JSON.stringify({
				permissions: { allow: ["Bash(git status:*)"] },
				env: { FOO: "bar" },
			}),
		);

		await initRepo(repo);

		const settings = JSON.parse(await read(repo, ".claude/settings.json"));
		expect(settings.permissions).toEqual({ allow: ["Bash(git status:*)"] });
		expect(settings.env).toEqual({ FOO: "bar" });
	});

	it("fails loudly and writes nothing when settings.json is malformed", async () => {
		const repo = await makeFixtureRepo();
		await mkdir(join(repo, ".claude"), { recursive: true });
		const malformed = "{ not valid json";
		await writeFile(join(repo, ".claude/settings.json"), malformed);

		await expect(initRepo(repo)).rejects.toThrow();

		expect(await read(repo, ".claude/settings.json")).toBe(malformed);
	});

	it("adds .rpt to gitignore exactly once across repeated runs", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		await initRepo(repo);
		const ignored = await read(repo, ".gitignore");
		expect(ignored.match(/^\.rpt\/$/gm)).toHaveLength(1);
	});

	it("creates a config file that loadConfig accepts", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		expect(JSON.parse(await read(repo, "rpt.config.json"))).toHaveProperty("thresholds");
	});

	it("creates a pricing file with no invented rates", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		const pricing = JSON.parse(await read(repo, ".rpt/pricing.json"));
		expect(pricing.version).toBe(1);
		expect(Object.values(pricing.rates)).toEqual([]);
	});

	it("is idempotent", async () => {
		const repo = await makeFixtureRepo();
		const first = await initRepo(repo);
		const second = await initRepo(repo);
		expect(first.hooksInstalled).toBe(true);
		expect(second.configCreated).toBe(false);
	});
});
