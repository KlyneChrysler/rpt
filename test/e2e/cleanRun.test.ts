import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gateCommit } from "../../src/app/gateCommit.js";
import { initRepo } from "../../src/app/initRepo.js";
import { recordCommit } from "../../src/app/recordCommit.js";
import { verifyRun } from "../../src/app/verifyRun.js";
import { git } from "../../src/git/exec.js";
import { listRuns } from "../../src/store/runIndex.js";
import { rptDirOf } from "../../src/store/paths.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

// A repository whose tests pass and which has deliberately turned the coverage
// check off. This is the path most users are on, and until this suite existed
// nothing anywhere asserted a run could reach VERIFIED at all.
async function cleanRun(): Promise<string> {
	const repo = await makeFixtureRepo();
	await initRepo(repo);
	await writeFile(
		join(repo, "rpt.config.json"),
		JSON.stringify({ testCommand: "exit 0", verifiers: { testQuality: "off" } }),
	);
	await driveFakeAgent(repo, [
		{ kind: "start", transcriptPath: null },
		{ kind: "edit", path: "a.ts", body: "export const a = 1;\n" },
		{ kind: "stop" },
	]);
	return repo;
}

describe("clean run, end to end", () => {
	it("reaches VERIFIED when every enabled verifier passed and the log has no gaps", async () => {
		const verdict = await verifyRun(await cleanRun(), 1);
		expect(verdict.name).toBe("VERIFIED");
	});

	it("omits a verifier the config turned off rather than counting it as a skip", async () => {
		const verdict = await verifyRun(await cleanRun(), 1);
		expect(verdict.results.map((result) => result.id)).not.toContain("test-quality");
		expect(verdict.results.every((result) => result.status === "passed")).toBe(true);
	});

	it("passes the gate with no human, because a low-risk verified run needs none", async () => {
		const repo = await cleanRun();
		expect((await gateCommit(repo)).allowed).toBe(true);
	});

	it("lands a note saying it was cleared automatically", async () => {
		const repo = await cleanRun();
		await gateCommit(repo);
		await git(repo, ["add", "-A"]);
		await git(repo, ["commit", "-q", "-m", "change", "--no-verify"]);
		await recordCommit(repo);
		const note = await git(repo, ["notes", "--ref=rpt", "show", "HEAD"]);
		expect(note).toContain("verdict VERIFIED");
		expect(note).toContain("cleared automatically");
		expect(note).not.toContain("BYPASSED");
	});

	it("ends RECORDED, so the next commit is not gated on it", async () => {
		const repo = await cleanRun();
		await gateCommit(repo);
		await git(repo, ["add", "-A"]);
		await git(repo, ["commit", "-q", "-m", "change", "--no-verify"]);
		await recordCommit(repo);
		expect((await listRuns(rptDirOf(repo))).find((entry) => entry.id === 1)?.state).toBe("RECORDED");
	});

	// A run that was verified without a human still needs no approval to have
	// happened, and the record must not imply one did.
	it("records no approval for a run nobody had to decide", async () => {
		const repo = await cleanRun();
		await gateCommit(repo);
		const { readApproval } = await import("../../src/app/approveRun.js");
		expect(await readApproval(repo, 1)).toBeNull();
	});
});
