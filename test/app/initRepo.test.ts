import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

	it("does not duplicate the gitignore entry when the file uses CRLF line endings", async () => {
		const repo = await makeFixtureRepo();
		await writeFile(join(repo, ".gitignore"), "node_modules\r\n.rpt/\r\n");

		const report = await initRepo(repo);

		expect(report.gitignoreUpdated).toBe(false);
		const ignored = await read(repo, ".gitignore");
		expect(ignored.match(/\.rpt\/[ \t]*\r?$/gm)).toHaveLength(1);
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

	// A run cannot start outside a git repository: snapshotting is a git commit-tree.
	// Without this check the first failure surfaced hours later, as a session that
	// recorded nothing, from a hook that had already exited zero.
	it("refuses to initialise outside a git repository", async () => {
		const bare = await mkdtemp(join(tmpdir(), "rpt-bare-"));
		await expect(initRepo(bare)).rejects.toThrow(/git repository/i);
	});

	it("writes nothing at all when there is no git repository", async () => {
		const bare = await mkdtemp(join(tmpdir(), "rpt-bare-"));
		await expect(initRepo(bare)).rejects.toThrow();
		await expect(read(bare, "rpt.config.json")).rejects.toThrow();
	});

	it("initialises the repository root when run from a subdirectory", async () => {
		const repo = await makeFixtureRepo();
		const nested = join(repo, "src/deep");
		await mkdir(nested, { recursive: true });

		const report = await initRepo(nested);

		expect(report.repoRoot).toBe(repo);
		expect(JSON.parse(await read(repo, "rpt.config.json"))).toHaveProperty("thresholds");
	});

	it("reports which models the pricing file was seeded with", async () => {
		const repo = await makeFixtureRepo();
		const report = await initRepo(repo);
		// A fixture repository under the OS temp directory has no Claude Code
		// transcript history, so there is nothing to seed. What matters is that
		// the field is present and honest rather than absent.
		expect(report.pricingModelsSeeded).toEqual([]);
		expect(JSON.parse(await read(repo, ".rpt/pricing.json")).rates).toEqual({});
	});

	it("installs the git pre-commit gate hook", async () => {
		const repo = await makeFixtureRepo();
		const report = await initRepo(repo);
		expect(report.gitHooksInstalled).toBe(true);
		expect(await read(repo, ".git/hooks/pre-commit")).toContain("rpt gate");
	});

	it("is idempotent", async () => {
		const repo = await makeFixtureRepo();
		const first = await initRepo(repo);
		const second = await initRepo(repo);
		expect(first.hooksInstalled).toBe(true);
		expect(first.gitHooksInstalled).toBe(true);
		expect(second.configCreated).toBe(false);
		expect(second.gitHooksInstalled).toBe(false);
	});
});
