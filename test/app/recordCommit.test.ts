import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/app/terminalConfirm.js", () => ({ readFromControllingTerminal: vi.fn() }));

import { approveRun, rejectRun, type Actor } from "../../src/app/approveRun.js";
import { initRepo } from "../../src/app/initRepo.js";
import { recordCommit } from "../../src/app/recordCommit.js";
import { readFromControllingTerminal } from "../../src/app/terminalConfirm.js";
import { verifyRun } from "../../src/app/verifyRun.js";
import { git } from "../../src/git/exec.js";
import { listRuns } from "../../src/store/runIndex.js";
import { rptDirOf } from "../../src/store/paths.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

const human: Actor = { name: "klyne", interactive: true, agentContext: "human" };

beforeEach(() => {
	vi.mocked(readFromControllingTerminal).mockReset();
	vi.mocked(readFromControllingTerminal).mockImplementation(async (prompt: string) => /"([^"]+)"/.exec(prompt)?.[1] ?? "");
});

async function endedRun(): Promise<string> {
	const repo = await makeFixtureRepo();
	await initRepo(repo);
	await driveFakeAgent(repo, [
		{ kind: "start", transcriptPath: null },
		{ kind: "edit", path: "a.ts", body: "export const a = 1;\n" },
		{ kind: "stop" },
	]);
	await verifyRun(repo, 1);
	return repo;
}

async function commit(repo: string): Promise<void> {
	await writeFile(join(repo, "a.ts"), "export const a = 1;\n");
	await git(repo, ["add", "-A"]);
	await git(repo, ["commit", "-q", "-m", "change", "--no-verify"]);
}

async function committedRun(): Promise<string> {
	const repo = await endedRun();
	await approveRun(repo, 1, human);
	await commit(repo);
	return repo;
}

async function note(repo: string): Promise<string> {
	return git(repo, ["notes", "--ref=rpt", "show", "HEAD"]);
}

describe("recordCommit", () => {
	it("attaches a note to the new commit", async () => {
		const repo = await committedRun();
		await recordCommit(repo);
		expect(await note(repo)).toContain("run 1");
	});

	it("states the verdict and the risk level", async () => {
		const repo = await committedRun();
		await recordCommit(repo);
		expect(await note(repo)).toMatch(/verdict (VERIFIED|FAILED|UNVERIFIED)/);
		expect(await note(repo)).toMatch(/risk \d+ (LOW|MEDIUM|HIGH|CRITICAL)/);
	});

	it("distinguishes an override from a clean approval", async () => {
		const repo = await committedRun();
		await recordCommit(repo);
		expect(await note(repo)).toMatch(/approved despite UNVERIFIED by klyne/);
	});

	it("records a rejection as a rejection, never as an approval", async () => {
		const repo = await endedRun();
		await rejectRun(repo, 1, human);
		await commit(repo);
		await recordCommit(repo);
		const body = await note(repo);
		expect(body).toMatch(/rejected by klyne/);
		expect(body).not.toMatch(/approved/);
	});

	it("says a run nobody had to decide was cleared automatically", async () => {
		const repo = await endedRun();
		await commit(repo);
		await recordCommit(repo);
		expect(await note(repo)).toContain("cleared automatically");
	});

	it("includes a digest of the event log", async () => {
		const repo = await committedRun();
		await recordCommit(repo);
		expect(await note(repo)).toMatch(/digest sha256:[0-9a-f]{16}/);
	});

	it("does nothing and returns null when there is no adjudicated run", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		expect(await recordCommit(repo)).toBeNull();
	});

	it("does nothing when the active run has never been verified", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		await driveFakeAgent(repo, [{ kind: "start", transcriptPath: null }, { kind: "stop" }]);
		expect(await recordCommit(repo)).toBeNull();
	});

	it("says the cost is unknown rather than inventing one", async () => {
		const repo = await committedRun();
		await recordCommit(repo);
		expect(await note(repo)).toContain("cost unknown");
	});

	it("counts files from the observed diff, not from the agent's claims", async () => {
		const repo = await committedRun();
		await recordCommit(repo);
		expect(await note(repo)).toContain("files 1");
	});

	it("moves the run to RECORDED so the gate stops asking about it", async () => {
		const repo = await committedRun();
		await recordCommit(repo);
		expect((await listRuns(rptDirOf(repo))).find((entry) => entry.id === 1)?.state).toBe("RECORDED");
	});

	it("is not repeated on a second commit once the run is recorded", async () => {
		const repo = await committedRun();
		await recordCommit(repo);
		await writeFile(join(repo, "b.ts"), "export const b = 2;\n");
		await git(repo, ["add", "-A"]);
		await git(repo, ["commit", "-q", "-m", "second", "--no-verify"]);
		expect(await recordCommit(repo)).toBeNull();
	});
});
