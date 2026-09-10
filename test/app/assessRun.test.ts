import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessRun } from "../../src/app/assessRun.js";
import { DEFAULT_CONFIG } from "../../src/config/load.js";
import { fingerprintOf } from "../../src/domain/checksum.js";
import type { AgentRun } from "../../src/domain/run.js";
import type { Verdict } from "../../src/domain/verdict.js";
import { rptDirOf } from "../../src/store/paths.js";
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

// One sensitive auth path and a passing test run: 25 for the auth match, 1 for
// the single changed file, minus 5 for tests passing, which lands at 21 - above
// a block threshold of 20 and well below the default of 81.
const verdict: Verdict = {
	runId: 1,
	name: "VERIFIED",
	results: [
		{ id: "tests", status: "passed", reason: null, facts: {} },
		{
			id: "diff-integrity",
			status: "passed",
			reason: null,
			facts: { observedPaths: ["src/auth/pool.ts"], added: 1, removed: 0, undeclared: [], manifestChanged: false },
		},
	],
	decidedAt: "2026-09-10T10:06:00.000Z",
};

const STRICT_THRESHOLDS = { review: 5, approval: 10, block: 20 };

async function repoWithLiveConfig(config: Record<string, unknown>): Promise<string> {
	const repo = await mkdtemp(join(tmpdir(), "rpt-assessrun-"));
	await writeFile(join(repo, "rpt.config.json"), JSON.stringify(config));
	return repo;
}

describe("assessRun", () => {
	it("assesses a healthy run under its own verified snapshot", async () => {
		const repo = await repoWithLiveConfig({ thresholds: STRICT_THRESHOLDS });
		const snapshot = { ...DEFAULT_CONFIG, thresholds: STRICT_THRESHOLDS };
		await writeRunConfig(rptDirOf(repo), 1, snapshot);
		const result = await assessRun(repo, fixtureRun({ configFingerprint: fingerprintOf(snapshot) }), verdict);
		expect(result.assessment.level).toBe("CRITICAL");
		expect(result.configChangedSinceSnapshot).toBe(false);
	});

	// The attack the substitution closed: delete the snapshot and the run is
	// scored under rpt's defaults instead of a repository file the tamperer
	// already controls.
	it("ignores an attacker-relaxed live config when the snapshot is missing", async () => {
		const repo = await repoWithLiveConfig({ thresholds: { review: 97, approval: 98, block: 100 } });
		const result = await assessRun(repo, fixtureRun({ configFingerprint: "no-matching-snapshot" }), verdict);
		expect(result.assessment.level).not.toBe("LOW");
		expect(result.configChangedSinceSnapshot).toBe(true);
	});

	// The hole that substitution opened, and this closes: a project stricter
	// than rpt's defaults must not be relaxed by the same deletion. Under the
	// defaults this run is MEDIUM; under the repository's own thresholds it is
	// CRITICAL, and CRITICAL is what must survive.
	it("keeps a project's own stricter thresholds when the snapshot is missing", async () => {
		const repo = await repoWithLiveConfig({ thresholds: STRICT_THRESHOLDS });
		const result = await assessRun(repo, fixtureRun({ configFingerprint: "no-matching-snapshot" }), verdict);
		expect(result.assessment.level).toBe("CRITICAL");
		expect(result.config.thresholds).toEqual(STRICT_THRESHOLDS);
	});

	it("falls back to the defaults alone when the live config cannot be read either", async () => {
		const repo = await mkdtemp(join(tmpdir(), "rpt-assessrun-"));
		await writeFile(join(repo, "rpt.config.json"), "{not json", "utf8");
		const result = await assessRun(repo, fixtureRun({ configFingerprint: "no-matching-snapshot" }), verdict);
		expect(result.config).toEqual(DEFAULT_CONFIG);
	});

	it("reports the config that produced the winning assessment, so the record fingerprints the right one", async () => {
		const repo = await repoWithLiveConfig({ thresholds: { review: 97, approval: 98, block: 100 } });
		const result = await assessRun(repo, fixtureRun({ configFingerprint: "no-matching-snapshot" }), verdict);
		expect(result.config).toEqual(DEFAULT_CONFIG);
	});

	it("returns the facts the score was computed from", async () => {
		const repo = await repoWithLiveConfig({});
		const result = await assessRun(repo, fixtureRun(), verdict);
		expect(result.facts.pathsChanged).toEqual(["src/auth/pool.ts"]);
		expect(result.facts.fileCount).toBe(1);
	});
});
