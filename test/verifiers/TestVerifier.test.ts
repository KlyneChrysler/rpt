import { lstat, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/load.js";
import { createTestVerifier, testVerifier } from "../../src/verifiers/TestVerifier.js";
import type { RunContext } from "../../src/verifiers/Verifier.js";

async function contextRunning(command: string | null): Promise<RunContext> {
	const worktree = await mkdtemp(join(tmpdir(), "rpt-tv-"));
	await writeFile(join(worktree, "marker"), "");
	return {
		repoRoot: worktree,
		worktree,
		baseSha: "a".repeat(40),
		endSha: "b".repeat(40),
		config: { ...DEFAULT_CONFIG, testCommand: command },
		claims: { mutatedPaths: [], commands: [] },
	};
}

async function contextForNodeProject(opts: { repoHasNodeModules: boolean }): Promise<RunContext> {
	const repoRoot = await mkdtemp(join(tmpdir(), "rpt-tv-repo-"));
	const worktree = await mkdtemp(join(tmpdir(), "rpt-tv-wt-"));
	await writeFile(join(worktree, "package.json"), JSON.stringify({ scripts: { test: "exit 0" } }));
	if (opts.repoHasNodeModules) {
		await mkdir(join(repoRoot, "node_modules"), { recursive: true });
		await writeFile(join(repoRoot, "node_modules", "marker"), "");
	}
	return {
		repoRoot,
		worktree,
		baseSha: "a".repeat(40),
		endSha: "b".repeat(40),
		config: { ...DEFAULT_CONFIG, testCommand: "exit 0" },
		claims: { mutatedPaths: [], commands: [] },
	};
}

describe("testVerifier", () => {
	it("passes when the configured command exits zero", async () => {
		const result = await testVerifier.run(await contextRunning("exit 0"));
		expect(result.status).toBe("passed");
	});

	it("fails when the command exits non-zero and keeps the tail of the output", async () => {
		const result = await testVerifier.run(await contextRunning("echo 'boom failure' >&2; exit 1"));
		expect(result.status).toBe("failed");
		expect(String(result.facts.output)).toContain("boom failure");
	});

	it("skips with a reason when no command can be resolved", async () => {
		const result = await testVerifier.run(await contextRunning(null));
		expect(result.status).toBe("skipped");
		expect(result.reason).toMatch(/no test command/i);
	});

	it("reports the command it actually ran", async () => {
		const result = await testVerifier.run(await contextRunning("exit 0"));
		expect(result.facts.command).toBe("exit 0");
	});

	it("parses pass and fail counts when the output states them", async () => {
		const result = await testVerifier.run(await contextRunning("echo '184 passed, 0 failed'; exit 0"));
		expect(result.facts.passed).toBe(184);
		expect(result.facts.failed).toBe(0);
	});

	it("records unknown counts rather than guessing when the output is silent", async () => {
		const result = await testVerifier.run(await contextRunning("exit 0"));
		expect(result.facts.passed).toBeNull();
	});

	it("skips rather than fails when the worktree has no dependency directory available", async () => {
		const context = await contextForNodeProject({ repoHasNodeModules: false });
		const result = await testVerifier.run(context);
		expect(result.status).toBe("skipped");
		expect(result.reason).toMatch(/node_modules/i);
	});

	it("skips rather than fails when the command's binary does not exist", async () => {
		const result = await testVerifier.run(await contextRunning("definitely-not-a-real-binary-xyz-123"));
		expect(result.status).toBe("skipped");
		expect(result.reason).toMatch(/environment/i);
	});

	it("records what it did to the environment in the facts, for a linked dependency directory", async () => {
		const context = await contextForNodeProject({ repoHasNodeModules: true });
		const result = await testVerifier.run(context);
		expect(result.status).toBe("passed");
		expect(String(result.facts.environment)).toMatch(/node_modules/i);
	});

	it("records what it did to the environment in the facts, when no dependency directory is needed", async () => {
		const result = await testVerifier.run(await contextRunning("exit 0"));
		expect(typeof result.facts.environment).toBe("string");
	});

	it("skips rather than fails on a module resolution failure even with an ordinary non-127 exit code", async () => {
		const result = await testVerifier.run(
			await contextRunning("echo \"Error: Cannot find module 'left-pad'\" >&2; exit 1"),
		);
		expect(result.status).toBe("skipped");
		expect(result.reason).toMatch(/module/i);
	});

	it("does not relink node_modules when the worktree already has one", async () => {
		const context = await contextForNodeProject({ repoHasNodeModules: false });
		await mkdir(join(context.worktree, "node_modules"), { recursive: true });
		const result = await testVerifier.run(context);
		expect(result.status).toBe("passed");
		expect(String(result.facts.environment)).toMatch(/already present/i);
	});

	it("skips rather than fails when the command is killed by rpt's own timeout deadline", async () => {
		const verifier = createTestVerifier(150);
		const result = await verifier.run(await contextRunning("sleep 2"));
		expect(result.status).toBe("skipped");
		expect(result.reason).toMatch(/deadline/i);
		expect(result.reason).toContain("150ms");
	});

	it("formats the timeout deadline in seconds when it divides evenly", async () => {
		const verifier = createTestVerifier(1000);
		const result = await verifier.run(await contextRunning("sleep 2"));
		expect(result.status).toBe("skipped");
		expect(result.reason).toContain("1 second");
	});

	it("fails, not skips, when a suite that demonstrably ran also mentions a missing module", async () => {
		const result = await testVerifier.run(
			await contextRunning(
				"echo '12 passed, 1 failed'; echo \"assertion output: Cannot find module 'left-pad'\" >&2; exit 1",
			),
		);
		expect(result.status).toBe("failed");
		expect(result.facts.passed).toBe(12);
		expect(result.facts.failed).toBe(1);
	});

	it("recovers a stale or broken node_modules link instead of letting creation throw", async () => {
		const context = await contextForNodeProject({ repoHasNodeModules: true });
		await symlink(join(context.repoRoot, "does-not-exist"), join(context.worktree, "node_modules"), "dir");
		const result = await testVerifier.run(context);
		expect(result.status).toBe("passed");
		expect(String(result.facts.environment)).toMatch(/linked node_modules/i);
	});

	it("treats an existing valid node_modules symlink as already present, without touching it", async () => {
		const context = await contextForNodeProject({ repoHasNodeModules: true });
		// Points at a real directory that is not repoRoot/node_modules, to prove this
		// pre-existing link is left alone rather than replaced.
		await symlink(context.repoRoot, join(context.worktree, "node_modules"), "dir");
		const result = await testVerifier.run(context);
		expect(result.status).toBe("passed");
		expect(String(result.facts.environment)).toMatch(/already present/i);
	});

	it("removes the linked node_modules after the run, scoping the write-through window to execution", async () => {
		const context = await contextForNodeProject({ repoHasNodeModules: true });
		const result = await testVerifier.run(context);
		expect(result.status).toBe("passed");
		await expect(lstat(join(context.worktree, "node_modules"))).rejects.toThrow();
	});
});
