import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRun } from "../../src/app/loadRun.js";
import { initRepo } from "../../src/app/initRepo.js";
import { renderRun } from "../../src/cli/render.js";
import { git } from "../../src/git/exec.js";
import { diffNameStatus } from "../../src/git/diff.js";
import { eventLogOf, rptDirOf } from "../../src/store/paths.js";
import { activeRun } from "../../src/store/runIndex.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

async function recordedRun(): Promise<{ repo: string }> {
	const repo = await makeFixtureRepo();
	await initRepo(repo);
	await driveFakeAgent(repo, [
		{ kind: "start", transcriptPath: "test/fixtures/transcript.jsonl" },
		{ kind: "edit", path: "auth.ts", body: "export const timeout = 5000;\n" },
		{ kind: "bash", command: "pnpm test" },
		{ kind: "stop" },
	]);
	return { repo };
}

describe("a full recorded run", () => {
	it("ends in ENDED and becomes the active run", async () => {
		const { repo } = await recordedRun();
		const run = await loadRun(repo, 1);
		expect(run.state).toBe("ENDED");
		expect((await activeRun(rptDirOf(repo)))?.id).toBe(1);
	});

	it("records the agent's claim about the edited file", async () => {
		const { repo } = await recordedRun();
		expect((await loadRun(repo, 1)).claims.mutatedPaths).toEqual(["auth.ts"]);
	});

	it("observes the same file independently in the git diff", async () => {
		const { repo } = await recordedRun();
		const run = await loadRun(repo, 1);
		const observed = await diffNameStatus(repo, run.baseSha!, run.endSha!);
		expect(observed).toEqual([{ path: "auth.ts", status: "A" }]);
	});

	it("has no gaps", async () => {
		const { repo } = await recordedRun();
		expect((await loadRun(repo, 1)).hasGaps).toBe(false);
	});

	it("carries model usage from the transcript", async () => {
		const { repo } = await recordedRun();
		expect((await loadRun(repo, 1)).usage.length).toBeGreaterThan(0);
	});

	// Non-negotiable: git snapshotting works through a scratch index precisely so a
	// recorded run never touches the real one. diff --cached stays empty because
	// nothing was ever `git add`-ed against the repo's own index, and every line
	// git status reports must be an untracked addition rpt or the fake agent made
	// (auth.ts, rpt's own scaffolds) - never a staged or modified entry against the
	// tracked README.md the fixture repo seeded.
	it("never touches the user's staging area or the state of tracked files", async () => {
		const { repo } = await recordedRun();
		expect(await git(repo, ["diff", "--cached", "--name-only"])).toBe("");

		const status = await git(repo, ["status", "--porcelain"]);
		const lines = status.split("\n").filter((line) => line !== "");
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) expect(line.slice(0, 2)).toBe("??");
	});
});

describe("claimed versus observed", () => {
	// This is the property the whole project rests on: what the agent said it
	// changed and what rpt independently asks git about must be derived from two
	// unrelated sources - the folded event log for claims, a git diff between two
	// snapshots for the observation - and only then compared. A fake agent that
	// writes a file behind rpt's back (no PostToolUse hook at all, the same shape
	// a lost hook or an unadapted tool produces in a real session) is the test
	// that actually proves this: if diffNameStatus were quietly built from claims
	// instead of asking git, sneaky.ts would never show up here.
	it("catches a file the agent modified but never declared through a hook", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		await driveFakeAgent(repo, [{ kind: "start", transcriptPath: null }]);
		await driveFakeAgent(repo, [{ kind: "edit", path: "auth.ts", body: "export const timeout = 5000;\n" }]);

		// No hook is ever fired for this write - it lands on disk exactly as a
		// real tool call would leave it, but rpt is never told about it.
		await writeFile(join(repo, "sneaky.ts"), "export const sneaky = true;\n");

		await driveFakeAgent(repo, [{ kind: "stop" }]);

		const run = await loadRun(repo, 1);
		const observedPaths = (await diffNameStatus(repo, run.baseSha!, run.endSha!)).map((entry) => entry.path);

		expect(run.claims.mutatedPaths).toEqual(["auth.ts"]);
		expect(run.claims.mutatedPaths).not.toContain("sneaky.ts");
		expect(observedPaths).toEqual(expect.arrayContaining(["auth.ts", "sneaky.ts"]));
	});

	it("agrees with the claim when every mutation went through a hook", async () => {
		const { repo } = await recordedRun();
		const run = await loadRun(repo, 1);
		const observedPaths = (await diffNameStatus(repo, run.baseSha!, run.endSha!)).map((entry) => entry.path);
		expect(observedPaths).toEqual(run.claims.mutatedPaths);
	});
});

describe("a run with a gap in its event log", () => {
	// Non-negotiable: a gapped run can never be verified later, so it must be
	// visibly marked, not just internally flagged. Reproduces the same torn,
	// newline-less fragment eventLog.ts's own gap tests use - a crash mid-append.
	it("is marked hasGaps and surfaces a warning in the rendered run", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		await driveFakeAgent(repo, [{ kind: "start", transcriptPath: null }]);

		await appendFile(eventLogOf(rptDirOf(repo), 1), '{"runId":1,"seq":1,"kind":"Fi');

		await driveFakeAgent(repo, [{ kind: "stop" }]);

		const run = await loadRun(repo, 1);
		expect(run.hasGaps).toBe(true);
		expect(renderRun(run, "text")).toContain("cannot be verified");
	});
});
