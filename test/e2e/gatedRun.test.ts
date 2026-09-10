import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/app/terminalConfirm.js", () => ({ readFromControllingTerminal: vi.fn() }));

import { approveRun, type Actor } from "../../src/app/approveRun.js";
import { gateCommit } from "../../src/app/gateCommit.js";
import { initRepo } from "../../src/app/initRepo.js";
import { recordCommit } from "../../src/app/recordCommit.js";
import { readFromControllingTerminal } from "../../src/app/terminalConfirm.js";
import { verifyRun } from "../../src/app/verifyRun.js";
import { git } from "../../src/git/exec.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

const human: Actor = { name: "klyne", interactive: true, agentContext: "human" };

beforeEach(() => {
	vi.mocked(readFromControllingTerminal).mockReset();
	vi.mocked(readFromControllingTerminal).mockImplementation(async (prompt: string) => /"([^"]+)"/.exec(prompt)?.[1] ?? "");
});

afterEach(() => {
	delete process.env.RPT_BYPASS;
});

async function riskyRun(): Promise<string> {
	const repo = await makeFixtureRepo();
	await initRepo(repo);
	await writeFile(join(repo, "rpt.config.json"), JSON.stringify({ testCommand: "exit 0" }));
	await driveFakeAgent(repo, [
		{ kind: "start", transcriptPath: null },
		{ kind: "edit", path: "auth-pool.ts", body: "export const timeout = 5000;\n" },
		{ kind: "stop" },
	]);
	return repo;
}

async function commit(repo: string): Promise<void> {
	await git(repo, ["add", "-A"]);
	await git(repo, ["commit", "-q", "-m", "change", "--no-verify"]);
}

describe("gated run, end to end", () => {
	it("blocks, then allows after approval, then records an attestation", async () => {
		const repo = await riskyRun();
		expect((await gateCommit(repo)).allowed).toBe(false);

		await approveRun(repo, 1, human);
		expect((await gateCommit(repo)).allowed).toBe(true);

		await commit(repo);
		await recordCommit(repo);
		const note = await git(repo, ["notes", "--ref=rpt", "show", "HEAD"]);
		expect(note).toContain("run 1");
		expect(note).toMatch(/approved despite UNVERIFIED by klyne/);
	});

	it("stops gating once the run has been recorded", async () => {
		const repo = await riskyRun();
		await gateCommit(repo);
		await approveRun(repo, 1, human);
		await commit(repo);
		await recordCommit(repo);
		expect((await gateCommit(repo)).allowed).toBe(true);
	});

	it("never lets an agent context clear its own run", async () => {
		const repo = await riskyRun();
		await verifyRun(repo, 1);
		const agent: Actor = { name: "claude", interactive: true, agentContext: "agent" };
		await expect(approveRun(repo, 1, agent)).rejects.toThrow(/human/i);
		expect((await gateCommit(repo)).allowed).toBe(false);
	});

	it("records a bypassed commit as bypassed, never as cleared automatically", async () => {
		const repo = await riskyRun();
		process.env.RPT_BYPASS = "1";
		expect((await gateCommit(repo)).allowed).toBe(true);
		await commit(repo);
		await recordCommit(repo);
		const note = await git(repo, ["notes", "--ref=rpt", "show", "HEAD"]);
		expect(note).toContain("BYPASSED");
		expect(note).not.toContain("cleared automatically");
	});

	it("leaves the user's index and working tree untouched throughout", async () => {
		const repo = await riskyRun();
		await gateCommit(repo);
		expect(await git(repo, ["diff", "--cached", "--name-only"])).toBe("");
		expect(await git(repo, ["worktree", "list"])).not.toContain("rpt-wt-");
	});
});
