import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctor, type Check } from "../../src/app/doctor.js";
import { initRepo } from "../../src/app/initRepo.js";
import { pricingFileOf, rptDirOf } from "../../src/store/paths.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

function check(checks: Check[], id: string): Check | undefined {
	return checks.find((entry) => entry.id === id);
}

describe("doctor", () => {
	it("reports missing agent hooks in an uninitialised repo", async () => {
		expect(check(await doctor(await makeFixtureRepo()), "agent-hooks")?.ok).toBe(false);
	});

	it("reports healthy agent hooks after init", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		expect(check(await doctor(repo), "agent-hooks")?.ok).toBe(true);
	});

	it("reports the git gate hook after init", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		expect(check(await doctor(repo), "git-hooks")?.ok).toBe(true);
	});

	it("reports a missing git gate hook before init", async () => {
		expect(check(await doctor(await makeFixtureRepo()), "git-hooks")?.ok).toBe(false);
	});

	it("flags an unset pricing table rather than staying quiet", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		expect(check(await doctor(repo), "pricing")?.ok).toBe(false);
	});

	it("accepts a pricing table once rates are configured", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		const rates = { "claude-opus-5": { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 } };
		await writeFile(pricingFileOf(rptDirOf(repo)), JSON.stringify({ version: 1, rates }));
		expect(check(await doctor(repo), "pricing")?.ok).toBe(true);
	});

	it("reports config validity", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		expect(check(await doctor(repo), "config")?.ok).toBe(true);
	});

	it("reports an invalid config as invalid, with the reason", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		await writeFile(join(repo, "rpt.config.json"), JSON.stringify({ unknownKey: 1 }));
		const result = check(await doctor(repo), "config");
		expect(result?.ok).toBe(false);
		expect(result?.detail).not.toBe("");
	});

	it("reports no orphaned worktrees in a clean repo", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		expect(check(await doctor(repo), "worktrees")?.ok).toBe(true);
	});

	// The daemon check asks the lock and then probes the socket, because a
	// socket file outlives a daemon that was killed and "the file is there"
	// answers a different question from "something is listening".
	describe("the daemon check", () => {
		it("reports a daemon that is actually accepting connections", async () => {
			const repo = await makeFixtureRepo();
			await initRepo(repo);
			const { startDaemon } = await import("../../src/daemon/server.js");
			const { acquireDaemonLock } = await import("../../src/store/daemonLock.js");
			const { rptDirOf } = await import("../../src/store/paths.js");
			const rptDir = rptDirOf(repo);
			const release = await acquireDaemonLock(rptDir);
			const daemon = await startDaemon(rptDir, { idleMs: 60_000 });
			try {
				const result = check(await doctor(repo), "daemon");
				expect(result?.ok).toBe(true);
				expect(result?.detail).toMatch(/accepting connections/);
			} finally {
				await daemon.close();
				await release?.();
			}
		});

		it("flags a daemon that holds the lock but answers nothing", async () => {
			const repo = await makeFixtureRepo();
			await initRepo(repo);
			const { acquireDaemonLock } = await import("../../src/store/daemonLock.js");
			const { rptDirOf } = await import("../../src/store/paths.js");
			const release = await acquireDaemonLock(rptDirOf(repo));
			try {
				const result = check(await doctor(repo), "daemon");
				expect(result?.ok).toBe(false);
				expect(result?.detail).toMatch(/not accepting connections/);
			} finally {
				await release?.();
			}
		});

		it("calls a repository with no daemon healthy, because one is not required", async () => {
			const repo = await makeFixtureRepo();
			await initRepo(repo);
			expect(check(await doctor(repo), "daemon")?.ok).toBe(true);
		});
	});

	it("returns every check even when one fails", async () => {
		expect((await doctor(await makeFixtureRepo())).length).toBeGreaterThanOrEqual(5);
	});

	it("gives every check a distinct id", async () => {
		const checks = await doctor(await makeFixtureRepo());
		expect(new Set(checks.map((entry) => entry.id)).size).toBe(checks.length);
	});
});
