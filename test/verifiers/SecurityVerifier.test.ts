import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/load.js";
import { createSnapshot } from "../../src/git/snapshot.js";
import { securityVerifier } from "../../src/verifiers/SecurityVerifier.js";
import type { RunContext } from "../../src/verifiers/Verifier.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

async function contextAfter(writes: Record<string, string>): Promise<RunContext> {
	const repo = await makeFixtureRepo();
	const baseSha = await createSnapshot(repo, 1, "base");
	for (const [path, body] of Object.entries(writes)) await writeFile(join(repo, path), body);
	const endSha = await createSnapshot(repo, 1, "end");
	return {
		repoRoot: repo,
		worktree: repo,
		baseSha,
		endSha,
		config: DEFAULT_CONFIG,
		claims: { mutatedPaths: Object.keys(writes), commands: [] },
	};
}

// npm audit is our first real consumer here too: rather than mock child_process,
// these tests put a fake `npm` shell script ahead of the real one on PATH and let
// the verifier actually spawn it, so the exec plumbing and the JSON classification
// are both exercised against text shaped like npm really produces (captured by
// hand from a real `npm audit --json` run against a known-vulnerable package and
// against a missing lockfile).
const originalPath = process.env.PATH;

afterEach(() => {
	process.env.PATH = originalPath;
});

async function fakeNpmOnPath(script: string): Promise<void> {
	const bin = await mkdtemp(join(tmpdir(), "rpt-fakenpm-"));
	const npmPath = join(bin, "npm");
	await writeFile(npmPath, `#!/bin/sh\n${script}\n`);
	await chmod(npmPath, 0o755);
	process.env.PATH = `${bin}:${originalPath}`;
}

async function pathWithoutNpm(): Promise<void> {
	const realGit = execFileSync("which", ["git"]).toString().trim();
	const bin = await mkdtemp(join(tmpdir(), "rpt-nonpm-"));
	await symlink(realGit, join(bin, "git"));
	process.env.PATH = bin;
}

const CLEAN_AUDIT_JSON = JSON.stringify({ auditReportVersion: 2, vulnerabilities: {} });

// Shapes captured by hand from real `npm audit --json` runs: a report always
// carries per-package severities under `vulnerabilities` and, when it ran to
// completion, an aggregate `metadata.vulnerabilities` count by severity.
const HIGH_ONLY_AUDIT_JSON = JSON.stringify({
	auditReportVersion: 2,
	vulnerabilities: { qs: { severity: "high" } },
	metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
});
const LOW_ONLY_AUDIT_JSON = JSON.stringify({
	auditReportVersion: 2,
	vulnerabilities: { tmp: { severity: "low" } },
	metadata: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 0, critical: 0, total: 1 } },
});
const MIXED_AUDIT_JSON = JSON.stringify({
	auditReportVersion: 2,
	vulnerabilities: { tmp: { severity: "low" }, qs: { severity: "high" } },
	metadata: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 1, critical: 0, total: 2 } },
});
const ENOLOCK_AUDIT_JSON = JSON.stringify({ error: { code: "ENOLOCK", summary: "requires an existing lockfile" } });

describe("securityVerifier", () => {
	it("passes a clean change", async () => {
		const result = await securityVerifier.run(await contextAfter({ "a.ts": "export const a = 1;\n" }));
		expect(result.status).toBe("passed");
		expect(result.facts.secretFindings).toEqual([]);
	});

	it("fails when a private key is introduced", async () => {
		const result = await securityVerifier.run(
			await contextAfter({ "key.pem": "-----BEGIN RSA PRIVATE KEY-----\nabc\n" }),
		);
		expect(result.status).toBe("failed");
		expect(result.reason).toMatch(/secret/i);
	});

	it("records that the dependency audit was skipped when no manifest changed", async () => {
		const result = await securityVerifier.run(await contextAfter({ "a.ts": "export const a = 1;\n" }));
		expect(result.facts.audit).toBe("not-applicable");
	});

	it("never reports the secret's value in its reason", async () => {
		const result = await securityVerifier.run(
			await contextAfter({ "x.ts": 'const apiSecret = "Zq7Xk29fLp03Ta6BvNc81WdYh4Rj5MgS";\n' }),
		);
		expect(result.reason).not.toContain("Zq7Xk29");
	});

	it("skips the audit rather than failing when the worktree has no lockfile to audit", async () => {
		// package.json changed but no package-lock.json was ever committed - the
		// same "no dependency directory" shape TestVerifier hits, here surfacing
		// as no lockfile for the audit tool to read.
		const result = await securityVerifier.run(await contextAfter({ "package.json": "{}\n" }));
		expect(result.status).toBe("passed");
		expect(result.facts.audit).toBe("skipped");
	});

	it("skips the audit rather than failing when npm is not available", async () => {
		const repo = await makeFixtureRepo();
		const baseSha = await createSnapshot(repo, 1, "base");
		await writeFile(join(repo, "package.json"), "{}\n");
		await writeFile(join(repo, "package-lock.json"), "{}\n");
		const endSha = await createSnapshot(repo, 1, "end");
		const context: RunContext = {
			repoRoot: repo,
			worktree: repo,
			baseSha,
			endSha,
			config: DEFAULT_CONFIG,
			claims: { mutatedPaths: ["package.json", "package-lock.json"], commands: [] },
		};
		await pathWithoutNpm();
		const result = await securityVerifier.run(context);
		expect(result.status).toBe("passed");
		expect(result.facts.audit).toBe("skipped");
	});

	it("skips the audit rather than failing when the audit endpoint errors, and keeps the specific reason", async () => {
		await fakeNpmOnPath(`echo '${ENOLOCK_AUDIT_JSON}'; exit 1`);
		const context = await contextAfter({ "package.json": "{}\n", "package-lock.json": "{}\n" });
		const result = await securityVerifier.run(context);
		expect(result.status).toBe("passed");
		expect(result.facts.audit).toBe("skipped");
		// The classifier already knows exactly why (npm's own ENOLOCK error) -
		// that specific reason must survive, not be replaced by a generic
		// "command failed" message built from the exit code alone.
		expect(String(result.facts.auditReason)).toMatch(/enolock/i);
	});

	it("passes with a clean audit fact when the audit tool runs and finds nothing", async () => {
		await fakeNpmOnPath(`echo '${CLEAN_AUDIT_JSON}'; exit 0`);
		const context = await contextAfter({ "package.json": "{}\n", "package-lock.json": "{}\n" });
		const result = await securityVerifier.run(context);
		expect(result.status).toBe("passed");
		expect(result.facts.audit).toBe("clean");
	});

	it("passes rather than fails when the audit tool runs and only finds low severity advisories", async () => {
		// npm itself exits 0 here too: --audit-level=high means a low-only
		// report does not cross the failing threshold.
		await fakeNpmOnPath(`echo '${LOW_ONLY_AUDIT_JSON}'; exit 0`);
		const context = await contextAfter({ "package.json": "{}\n", "package-lock.json": "{}\n" });
		const result = await securityVerifier.run(context);
		expect(result.status).toBe("passed");
		expect(result.facts.audit).toBe("clean");
	});

	it("fails on a mixed report, and names the real severity rather than asserting one it did not check", async () => {
		await fakeNpmOnPath(`echo '${MIXED_AUDIT_JSON}'; exit 1`);
		const context = await contextAfter({ "package.json": "{}\n", "package-lock.json": "{}\n" });
		const result = await securityVerifier.run(context);
		expect(result.status).toBe("failed");
		expect(result.facts.audit).toBe("findings");
		expect(result.reason).toMatch(/1 high/i);
		expect(result.reason).not.toMatch(/low/i);
	});

	it("fails when the audit tool runs and reports a high severity finding, naming the count and severity", async () => {
		await fakeNpmOnPath(`echo '${HIGH_ONLY_AUDIT_JSON}'; exit 1`);
		const context = await contextAfter({ "package.json": "{}\n", "package-lock.json": "{}\n" });
		const result = await securityVerifier.run(context);
		expect(result.status).toBe("failed");
		expect(result.facts.audit).toBe("findings");
		expect(result.reason).toMatch(/audit/i);
		expect(result.reason).toMatch(/1 high/i);
	});

	it("skips the audit rather than failing, with a labelled reason, when the report exceeds rpt's output limit", async () => {
		// Mirrors TestVerifier's own maxBuffer-overflow handling: a report this
		// large should be labelled as an output-limit problem, not treated as
		// unparseable noise or blamed on the agent as a real finding.
		await fakeNpmOnPath("yes | head -c 40000000; exit 1");
		const context = await contextAfter({ "package.json": "{}\n", "package-lock.json": "{}\n" });
		const result = await securityVerifier.run(context);
		expect(result.status).toBe("passed");
		expect(result.facts.audit).toBe("skipped");
		expect(String(result.facts.auditReason)).toMatch(/output limit/i);
	}, 20000);

	it("links node_modules from the main checkout for the audit and removes it afterward", async () => {
		await fakeNpmOnPath(`echo '${CLEAN_AUDIT_JSON}'; exit 0`);
		const repoRoot = await makeFixtureRepo();
		const baseSha = await createSnapshot(repoRoot, 1, "base");
		await writeFile(join(repoRoot, "package.json"), "{}\n");
		await writeFile(join(repoRoot, "package-lock.json"), "{}\n");
		const endSha = await createSnapshot(repoRoot, 1, "end");
		await mkdir(join(repoRoot, "node_modules"), { recursive: true });
		await writeFile(join(repoRoot, "node_modules", "marker"), "");

		// A real worktree checkout of endSha, separate from repoRoot: it has the
		// tracked files but, like the isolated verification worktree this stands
		// in for, none of the untracked dependency directory.
		const worktree = await mkdtemp(join(tmpdir(), "rpt-sv-wt-"));
		await writeFile(join(worktree, "package.json"), "{}\n");
		await writeFile(join(worktree, "package-lock.json"), "{}\n");

		const context: RunContext = {
			repoRoot,
			worktree,
			baseSha,
			endSha,
			config: DEFAULT_CONFIG,
			claims: { mutatedPaths: ["package.json", "package-lock.json"], commands: [] },
		};
		const result = await securityVerifier.run(context);
		expect(result.status).toBe("passed");
		expect(result.facts.audit).toBe("clean");
		await expect(lstat(join(worktree, "node_modules"))).rejects.toThrow();
	});
});
