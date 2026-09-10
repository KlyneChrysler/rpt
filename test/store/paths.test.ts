import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findGitRoot, findRepoRoot, socketPathOf } from "../../src/store/paths.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

describe("findGitRoot", () => {
	it("finds the root from a nested subdirectory", async () => {
		const repo = await makeFixtureRepo();
		const nested = join(repo, "src/deep/deeper");
		await mkdir(nested, { recursive: true });
		expect(await findGitRoot(nested)).toBe(repo);
	});

	it("is null outside any git repository", async () => {
		expect(await findGitRoot(await mkdtemp(join(tmpdir(), "rpt-bare-")))).toBeNull();
	});
});

describe("findRepoRoot", () => {
	it("finds the git root from a nested subdirectory", async () => {
		const repo = await makeFixtureRepo();
		const nested = join(repo, "a/b");
		await mkdir(nested, { recursive: true });
		expect(await findRepoRoot(nested)).toBe(repo);
	});

	// A recorded directory need not be a git repository at all - it is the .rpt
	// directory, not .git, that says rpt has anything to report here.
	it("finds a directory that only has an rpt directory", async () => {
		const base = await mkdtemp(join(tmpdir(), "rpt-only-"));
		await mkdir(join(base, ".rpt/runs"), { recursive: true });
		await mkdir(join(base, "sub"), { recursive: true });
		expect(await findRepoRoot(join(base, "sub"))).toBe(base);
	});

	it("finds a git worktree whose .git is a file rather than a directory", async () => {
		const base = await mkdtemp(join(tmpdir(), "rpt-worktree-"));
		await writeFile(join(base, ".git"), "gitdir: /somewhere/else\n");
		await mkdir(join(base, "sub"), { recursive: true });
		expect(await findRepoRoot(join(base, "sub"))).toBe(base);
	});

	it("is null when neither marker is anywhere above", async () => {
		expect(await findRepoRoot(await mkdtemp(join(tmpdir(), "rpt-bare-")))).toBeNull();
	});
});

// process.platform is read at call time, so the win32 branch is reachable from
// a posix test run. Worth asserting rather than assuming: Windows has no unix
// domain sockets, and a daemon address that is still a filesystem path there is
// a daemon that can never bind.
describe("socketPathOf across platforms", () => {
	const real = process.platform;

	function pretendPlatform(platform: string): void {
		Object.defineProperty(process, "platform", { value: platform, configurable: true });
	}

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: real, configurable: true });
	});

	it("is a file inside .rpt on posix", () => {
		pretendPlatform("darwin");
		expect(socketPathOf("/repo/.rpt")).toBe("/repo/.rpt/daemon.sock");
	});

	it("is a named pipe on windows, not a path under .rpt", () => {
		pretendPlatform("win32");
		const address = socketPathOf("C:\\repo\\.rpt");
		expect(address.startsWith("\\\\.\\pipe\\rpt-")).toBe(true);
		expect(address).not.toContain(".rpt");
	});

	it("gives two repositories two different pipes", () => {
		pretendPlatform("win32");
		expect(socketPathOf("C:\\one\\.rpt")).not.toBe(socketPathOf("C:\\two\\.rpt"));
	});

	it("gives the same repository the same pipe every time", () => {
		pretendPlatform("win32");
		expect(socketPathOf("C:\\one\\.rpt")).toBe(socketPathOf("C:\\one\\.rpt"));
	});
});
