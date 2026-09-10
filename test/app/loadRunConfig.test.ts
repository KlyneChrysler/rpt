import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRunConfig } from "../../src/app/loadRunConfig.js";
import { DEFAULT_CONFIG } from "../../src/config/load.js";
import { fingerprintOf } from "../../src/domain/checksum.js";
import type { AgentRun } from "../../src/domain/run.js";
import { rptDirOf, runConfigPathOf, runDirOf } from "../../src/store/paths.js";
import { writeRunConfig } from "../../src/store/runConfig.js";

function fixtureRun(overrides: Partial<AgentRun> = {}): AgentRun {
	return {
		id: 1,
		task: "t",
		state: "VERIFYING",
		baseSha: "abc",
		endSha: "def",
		configFingerprint: null,
		startedAt: "2026-09-10T10:00:00.000Z",
		endedAt: "2026-09-10T10:05:00.000Z",
		hasGaps: false,
		claims: { mutatedPaths: [], commands: [] },
		usage: [],
		...overrides,
	};
}

describe("resolveRunConfig", () => {
	it("reads the run's own verified snapshot, not a live re-read, for the config value returned", async () => {
		const repo = await mkdtemp(join(tmpdir(), "rpt-loadrunconfig-"));
		const snapshot = { ...DEFAULT_CONFIG, testCommand: "snapshot command" };
		await writeRunConfig(rptDirOf(repo), 1, snapshot);
		// Live still says the same thing right now - this test is about which
		// source resolveRunConfig reads from, not about drift, which the next
		// test covers.
		await writeFile(join(repo, "rpt.config.json"), JSON.stringify(snapshot));
		const run = fixtureRun({ configFingerprint: fingerprintOf(snapshot) });
		const resolved = await resolveRunConfig(repo, run);
		expect(resolved.config.testCommand).toBe("snapshot command");
		expect(resolved.configChangedSinceSnapshot).toBe(false);
	});

	it("reports drift when a live read no longer matches the verified snapshot", async () => {
		const repo = await mkdtemp(join(tmpdir(), "rpt-loadrunconfig-"));
		await writeRunConfig(rptDirOf(repo), 1, DEFAULT_CONFIG);
		await writeFile(join(repo, "rpt.config.json"), JSON.stringify({ testCommand: "edited after the run started" }));
		const run = fixtureRun({ configFingerprint: fingerprintOf(DEFAULT_CONFIG) });
		const resolved = await resolveRunConfig(repo, run);
		expect(resolved.configChangedSinceSnapshot).toBe(true);
	});

	it("falls back to a live read, with no drift claim, for a run that predates the snapshot feature", async () => {
		const repo = await mkdtemp(join(tmpdir(), "rpt-loadrunconfig-"));
		await writeFile(join(repo, "rpt.config.json"), JSON.stringify({ testCommand: "live command" }));
		const run = fixtureRun({ configFingerprint: null });
		const resolved = await resolveRunConfig(repo, run);
		expect(resolved.config.testCommand).toBe("live command");
		expect(resolved.configChangedSinceSnapshot).toBe(false);
	});

	// The exact attack this closes: deleting the snapshot file used to fall
	// back to a live read silently, and the drift comparison then compared
	// that live read against itself - both the protection and the alarm
	// turned off by the same removal. A run that has a recorded fingerprint
	// but no snapshot to verify it against now forces drift instead.
	it("forces drift when the snapshot is missing for a run that should have one", async () => {
		const repo = await mkdtemp(join(tmpdir(), "rpt-loadrunconfig-"));
		await writeFile(join(repo, "rpt.config.json"), JSON.stringify({}));
		const run = fixtureRun({ configFingerprint: "some-fingerprint-with-no-matching-snapshot" });
		const resolved = await resolveRunConfig(repo, run);
		expect(resolved.configChangedSinceSnapshot).toBe(true);
	});

	it("forces drift when the snapshot on disk does not match the fingerprint RunStarted recorded", async () => {
		const repo = await mkdtemp(join(tmpdir(), "rpt-loadrunconfig-"));
		await writeRunConfig(rptDirOf(repo), 1, DEFAULT_CONFIG);
		const run = fixtureRun({ configFingerprint: "a-fingerprint-that-does-not-match-the-real-snapshot" });
		const resolved = await resolveRunConfig(repo, run);
		expect(resolved.configChangedSinceSnapshot).toBe(true);
	});

	it("treats a corrupt snapshot as drift rather than throwing with no repair path", async () => {
		const repo = await mkdtemp(join(tmpdir(), "rpt-loadrunconfig-"));
		await mkdir(runDirOf(rptDirOf(repo), 1), { recursive: true });
		await writeFile(runConfigPathOf(rptDirOf(repo), 1), "{not json", "utf8");
		await writeFile(join(repo, "rpt.config.json"), JSON.stringify({}));
		const run = fixtureRun({ configFingerprint: "whatever" });
		const resolved = await resolveRunConfig(repo, run);
		expect(resolved.configChangedSinceSnapshot).toBe(true);
	});

	it("falls back to DEFAULT_CONFIG rather than throwing when both the snapshot and the live config are unusable", async () => {
		const repo = await mkdtemp(join(tmpdir(), "rpt-loadrunconfig-"));
		await writeFile(join(repo, "rpt.config.json"), "{not json");
		const run = fixtureRun({ configFingerprint: "whatever" });
		const resolved = await resolveRunConfig(repo, run);
		expect(resolved.config).toEqual(DEFAULT_CONFIG);
		expect(resolved.configChangedSinceSnapshot).toBe(true);
	});
});
