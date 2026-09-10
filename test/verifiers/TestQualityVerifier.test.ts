import { lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/load.js";
import { createSnapshot } from "../../src/git/snapshot.js";
import { testQualityVerifier } from "../../src/verifiers/TestQualityVerifier.js";
import type { RunContext } from "../../src/verifiers/Verifier.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

async function contextWith(options: { coverageCommand: string | null; lcov?: string }): Promise<RunContext> {
	const repo = await makeFixtureRepo();
	const baseSha = await createSnapshot(repo, 1, "base");
	await writeFile(join(repo, "auth.ts"), "line1\nline2\nline3\n");
	const endSha = await createSnapshot(repo, 1, "end");
	if (options.lcov !== undefined) {
		await mkdir(join(repo, "coverage"), { recursive: true });
		await writeFile(join(repo, "coverage", "lcov.info"), options.lcov);
	}
	return {
		repoRoot: repo,
		worktree: repo,
		baseSha,
		endSha,
		config: { ...DEFAULT_CONFIG, coverageCommand: options.coverageCommand },
		claims: { mutatedPaths: ["auth.ts"], commands: [] },
	};
}

// Models the real shape of a run: repoRoot is the main checkout (it may have a
// real node_modules), worktree is the bare verification checkout that only has
// what git tracked - package.json, never node_modules - so the verifier has to
// establish its own runnable environment the same way TestVerifier does.
async function nodeProjectContext(options: {
	repoHasNodeModules: boolean;
	coverageCommand: string;
}): Promise<RunContext> {
	const repo = await makeFixtureRepo();
	const baseSha = await createSnapshot(repo, 1, "base");
	await writeFile(join(repo, "auth.ts"), "line1\nline2\nline3\n");
	const endSha = await createSnapshot(repo, 1, "end");

	const worktree = await mkdtemp(join(tmpdir(), "rpt-tqv-wt-"));
	await writeFile(join(worktree, "package.json"), "{}\n");
	if (options.repoHasNodeModules) await mkdir(join(repo, "node_modules"), { recursive: true });

	return {
		repoRoot: repo,
		worktree,
		baseSha,
		endSha,
		config: { ...DEFAULT_CONFIG, coverageCommand: options.coverageCommand },
		claims: { mutatedPaths: ["auth.ts"], commands: [] },
	};
}

describe("testQualityVerifier", () => {
	it("skips with a reason when no coverage command is configured", async () => {
		const result = await testQualityVerifier.run(await contextWith({ coverageCommand: null }));
		expect(result.status).toBe("skipped");
		expect(result.reason).toMatch(/coverage/i);
	});

	it("skips when the coverage run produced no lcov file", async () => {
		const result = await testQualityVerifier.run(await contextWith({ coverageCommand: "true" }));
		expect(result.status).toBe("skipped");
	});

	it("reports the fraction of changed lines that tests executed", async () => {
		const lcov = ["SF:auth.ts", "DA:1,1", "DA:2,1", "DA:3,0", "end_of_record"].join("\n");
		const result = await testQualityVerifier.run(await contextWith({ coverageCommand: "true", lcov }));
		expect(result.facts.changeCoverage).toBeCloseTo(2 / 3, 5);
	});

	it("passes when coverage of the change is complete", async () => {
		const lcov = ["SF:auth.ts", "DA:1,1", "DA:2,1", "DA:3,1", "end_of_record"].join("\n");
		const result = await testQualityVerifier.run(await contextWith({ coverageCommand: "true", lcov }));
		expect(result.status).toBe("passed");
	});

	it("skips when disabled via config, without ever touching the coverage command", async () => {
		const context = await contextWith({ coverageCommand: "true" });
		context.config = { ...context.config, verifiers: { testQuality: "off" } };
		const result = await testQualityVerifier.run(context);
		expect(result.status).toBe("skipped");
		expect(result.reason).toMatch(/disabled/i);
	});

	it("in warn mode, a low-coverage change still passes but the reason states the shortfall instead of going silent", async () => {
		const lcov = ["SF:auth.ts", "DA:1,1", "DA:2,0", "DA:3,0", "end_of_record"].join("\n");
		const context = await contextWith({ coverageCommand: "true", lcov });
		context.config = { ...context.config, verifiers: { testQuality: "warn" } };
		const result = await testQualityVerifier.run(context);
		expect(result.status).toBe("passed");
		expect(result.reason).toMatch(/33%|1\/3| only /i);
		expect(result.facts.changeCoverage).toBeCloseTo(1 / 3, 5);
	});

	it("in require mode, the same low-coverage change fails", async () => {
		const lcov = ["SF:auth.ts", "DA:1,1", "DA:2,0", "DA:3,0", "end_of_record"].join("\n");
		const context = await contextWith({ coverageCommand: "true", lcov });
		context.config = { ...context.config, verifiers: { testQuality: "require" } };
		const result = await testQualityVerifier.run(context);
		expect(result.status).toBe("failed");
		expect(result.reason).not.toBeNull();
	});

	it("does not count a changed file the coverage tool never measured as zero-covered", async () => {
		const repo = await makeFixtureRepo();
		const baseSha = await createSnapshot(repo, 1, "base");
		await writeFile(join(repo, "auth.ts"), "line1\nline2\nline3\n");
		await writeFile(join(repo, "other.ts"), "a\nb\n");
		const endSha = await createSnapshot(repo, 1, "end");
		const lcov = ["SF:auth.ts", "DA:1,1", "DA:2,1", "DA:3,1", "end_of_record"].join("\n");
		await mkdir(join(repo, "coverage"), { recursive: true });
		await writeFile(join(repo, "coverage", "lcov.info"), lcov);

		const context: RunContext = {
			repoRoot: repo,
			worktree: repo,
			baseSha,
			endSha,
			config: { ...DEFAULT_CONFIG, coverageCommand: "true" },
			claims: { mutatedPaths: ["auth.ts", "other.ts"], commands: [] },
		};
		const result = await testQualityVerifier.run(context);
		expect(result.status).toBe("passed");
		expect(result.facts.changedLineCount).toBe(3);
		expect(result.facts.coveredLineCount).toBe(3);
		expect(result.facts.changeCoverage).toBe(1);
		expect(result.facts.unmeasuredLineCount).toBe(2);
	});

	it("skips, rather than passes or fails, when none of the changed lines were measured at all", async () => {
		const lcov = ["SF:unrelated.ts", "DA:1,1", "end_of_record"].join("\n");
		const result = await testQualityVerifier.run(await contextWith({ coverageCommand: "true", lcov }));
		expect(result.status).toBe("skipped");
		expect(result.reason).toMatch(/coverage/i);
	});

	it("scores only the instrumented lines: unrecorded lines count toward neither side of the fraction", async () => {
		// auth.ts changes 5 lines. The lcov report has no DA: record at all for
		// lines 4 and 5 - as a real coverage tool would for blank lines, an
		// import, or a type-only line - so those two must be excluded from both
		// the numerator and the denominator, not folded in as uncovered. Of the
		// three lines the tool did instrument, two ran and one did not: 2/3.
		const repo = await makeFixtureRepo();
		const baseSha = await createSnapshot(repo, 1, "base");
		await writeFile(join(repo, "auth.ts"), "a\nb\nc\nd\ne\n");
		const endSha = await createSnapshot(repo, 1, "end");
		const lcov = ["SF:auth.ts", "DA:1,1", "DA:2,0", "DA:3,1", "end_of_record"].join("\n");
		await mkdir(join(repo, "coverage"), { recursive: true });
		await writeFile(join(repo, "coverage", "lcov.info"), lcov);

		const context: RunContext = {
			repoRoot: repo,
			worktree: repo,
			baseSha,
			endSha,
			config: { ...DEFAULT_CONFIG, coverageCommand: "true" },
			claims: { mutatedPaths: ["auth.ts"], commands: [] },
		};
		const result = await testQualityVerifier.run(context);
		expect(result.facts.changedLineCount).toBe(3);
		expect(result.facts.coveredLineCount).toBe(2);
		expect(result.facts.uninstrumentedLineCount).toBe(2);
		expect(result.facts.changeCoverage).toBeCloseTo(2 / 3, 5);
	});

	it("skips with a reason naming node_modules when the main checkout has none to link", async () => {
		const context = await nodeProjectContext({ repoHasNodeModules: false, coverageCommand: "true" });
		const result = await testQualityVerifier.run(context);
		expect(result.status).toBe("skipped");
		expect(result.reason).toMatch(/node_modules/i);
	});

	it("links node_modules from the main checkout to run the coverage command, then removes the link", async () => {
		const command =
			"mkdir -p coverage && printf 'SF:auth.ts\\nDA:1,1\\nDA:2,1\\nDA:3,1\\nend_of_record\\n' > coverage/lcov.info";
		const context = await nodeProjectContext({ repoHasNodeModules: true, coverageCommand: command });
		const result = await testQualityVerifier.run(context);
		expect(result.status).toBe("passed");
		expect(result.facts.changeCoverage).toBe(1);
		await expect(lstat(join(context.worktree, "node_modules"))).rejects.toThrow();
	});
});
