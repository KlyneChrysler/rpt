import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installGitHooks } from "../../src/app/installGitHooks.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";
import { IS_WINDOWS } from "../support/platform.js";

function hookPath(repo: string, name: string): string {
	return join(repo, ".git", "hooks", name);
}

describe("installGitHooks", () => {
	it("writes a pre-commit hook that runs the gate", async () => {
		const repo = await makeFixtureRepo();
		await installGitHooks(repo);
		expect(await readFile(hookPath(repo, "pre-commit"), "utf8")).toContain("rpt gate");
	});

	// Windows has no executable bit and Git for Windows runs hooks through its
	// own bash regardless of one, so this is a posix-only property of the file.
	it.skipIf(IS_WINDOWS)("marks the hook executable where that means something", async () => {
		const repo = await makeFixtureRepo();
		await installGitHooks(repo);
		expect((await stat(hookPath(repo, "pre-commit"))).mode & 0o111).not.toBe(0);
	});

	it("appends to an existing hook rather than replacing it", async () => {
		const repo = await makeFixtureRepo();
		const path = hookPath(repo, "pre-commit");
		await writeFile(path, "#!/bin/sh\nexisting-linter\n", "utf8");
		await chmod(path, 0o755);
		await installGitHooks(repo);
		const body = await readFile(path, "utf8");
		expect(body).toContain("existing-linter");
		expect(body).toContain("rpt gate");
	});

	it("is a no-op when the hook is already installed", async () => {
		const repo = await makeFixtureRepo();
		expect(await installGitHooks(repo)).toBe(true);
		const first = await readFile(hookPath(repo, "pre-commit"), "utf8");
		expect(await installGitHooks(repo)).toBe(false);
		expect(await readFile(hookPath(repo, "pre-commit"), "utf8")).toBe(first);
	});

	it("never lets the post-commit hook fail the commit", async () => {
		const repo = await makeFixtureRepo();
		await installGitHooks(repo);
		expect(await readFile(hookPath(repo, "post-commit"), "utf8")).toContain("|| true");
	});

	it("keeps exactly one shebang when it appends", async () => {
		const repo = await makeFixtureRepo();
		const path = hookPath(repo, "pre-commit");
		await writeFile(path, "#!/bin/sh\nexisting-linter\n", "utf8");
		await installGitHooks(repo);
		const shebangs = (await readFile(path, "utf8")).split("\n").filter((line) => line.startsWith("#!"));
		expect(shebangs).toHaveLength(1);
	});
});
