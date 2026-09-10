import { describe, expect, it } from "vitest";
import { approveRun, isConfirmed, readApproval, rejectRun, type Actor } from "../../src/app/approveRun.js";
import { initRepo } from "../../src/app/initRepo.js";
import { readVerdict, verifyRun } from "../../src/app/verifyRun.js";
import { appendEvent } from "../../src/store/eventLog.js";
import { rptDirOf } from "../../src/store/paths.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

const human: Actor = { name: "klyne", interactive: true, agentContext: "human" };
const agent: Actor = { name: "claude", interactive: false, agentContext: "agent" };

async function verifiedRepo(): Promise<string> {
	const repo = await makeFixtureRepo();
	await initRepo(repo);
	await driveFakeAgent(repo, [
		{ kind: "start", transcriptPath: null },
		{ kind: "edit", path: "a.ts", body: "1\n" },
		{ kind: "stop" },
	]);
	await verifyRun(repo, 1);
	return repo;
}

// Touches an auth path, a database path, an infra path and a manifest file
// in the same run - enough sensitive-path and dependency-change points alone
// (25 + 20 + 20 + 20 = 85) to clear the default block threshold (81) before
// even counting the "tests unknown", "scan skipped" or files-changed points
// this fixture also always produces. Flat, repo-root filenames (no
// subdirectories) so the fake agent's plain writeFile, which does not create
// parent directories, can write them: "auth.ts" matches sensitivePaths'
// "**/*auth*.*", "repository.ts" matches "**/*repository*.*", "Dockerfile"
// matches "Dockerfile*", and "package.json" is a manifest DiffIntegrityVerifier
// recognises directly.
async function criticalRepo(): Promise<string> {
	const repo = await makeFixtureRepo();
	await initRepo(repo);
	await driveFakeAgent(repo, [
		{ kind: "start", transcriptPath: null },
		{ kind: "edit", path: "auth.ts", body: "1\n" },
		{ kind: "edit", path: "repository.ts", body: "1\n" },
		{ kind: "edit", path: "Dockerfile", body: "1\n" },
		{ kind: "edit", path: "package.json", body: "{}\n" },
		{ kind: "stop" },
	]);
	await verifyRun(repo, 1);
	return repo;
}

describe("approveRun", () => {
	it("records an approval by a human at a terminal", async () => {
		const approval = await approveRun(await verifiedRepo(), 1, human);
		expect(approval.decision).toBe("approved");
		expect(approval.by).toBe("klyne");
	});

	it("refuses an actor running inside a known agent context", async () => {
		await expect(approveRun(await verifiedRepo(), 1, agent)).rejects.toThrow(/human/i);
	});

	it("refuses a non-interactive actor even outside a known agent context", async () => {
		const piped: Actor = { name: "ci", interactive: false, agentContext: "human" };
		await expect(approveRun(await verifiedRepo(), 1, piped)).rejects.toThrow(/terminal/i);
	});

	// The brief demands refusal when the check cannot determine what it is
	// running inside. A silent environment (no known agent marker, but also no
	// positive confirmation a human is present) must refuse exactly like a
	// known agent context does, not be read as proof of a human.
	it("refuses an actor whose agent context could not be determined", async () => {
		const uncertain: Actor = { name: "?", interactive: true, agentContext: "unknown" };
		await expect(approveRun(await verifiedRepo(), 1, uncertain)).rejects.toThrow(/could not be determined/i);
	});

	it("marks approval of an unverified run as an override", async () => {
		const approval = await approveRun(await verifiedRepo(), 1, human);
		expect(approval.override).toBe(true);
	});

	it("persists the risk level the human was actually shown", async () => {
		const approval = await approveRun(await verifiedRepo(), 1, human);
		expect(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).toContain(approval.level);
	});

	it("refuses to approve a run twice", async () => {
		const repo = await verifiedRepo();
		await approveRun(repo, 1, human);
		await expect(approveRun(repo, 1, human)).rejects.toThrow(/already/i);
	});

	it("records a rejection", async () => {
		const rejection = await rejectRun(await verifiedRepo(), 1, human);
		expect(rejection.decision).toBe("rejected");
	});

	it("refuses to approve a run that does not exist", async () => {
		await expect(approveRun(await verifiedRepo(), 99, human)).rejects.toThrow();
	});

	it("refuses an approver name containing a newline", async () => {
		const forger: Actor = { name: "klyne\nrpt: FORGED LINE", interactive: true, agentContext: "human" };
		await expect(approveRun(await verifiedRepo(), 1, forger)).rejects.toThrow(/control character/i);
	});

	it("refuses an empty approver name", async () => {
		const nameless: Actor = { name: "", interactive: true, agentContext: "human" };
		await expect(approveRun(await verifiedRepo(), 1, nameless)).rejects.toThrow();
	});

	it("has no path from CRITICAL risk to approved", async () => {
		const repo = await criticalRepo();
		await expect(approveRun(repo, 1, human)).rejects.toThrow(/CRITICAL/);
	});

	it("still allows rejecting a CRITICAL run - refusing is not signing off", async () => {
		const rejection = await rejectRun(await criticalRepo(), 1, human);
		expect(rejection.decision).toBe("rejected");
	});

	it("does not let an already-recorded approval be approved again by re-deriving the wrong decision", async () => {
		const repo = await verifiedRepo();
		await approveRun(repo, 1, human);
		await expect(rejectRun(repo, 1, human)).rejects.toThrow();
	});

	// A crash between the event append (source of truth) succeeding and the
	// approval.json write failing must be recoverable: the retry heals the
	// missing file rather than being refused by the duplicate check (no file
	// exists yet) or by re-appending a second, illegal event.
	it("heals a missing approval file when the granting event was already recorded", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		await appendEvent(rptDirOf(repo), 1, {
			ts: new Date().toISOString(),
			source: "rpt",
			kind: "ApprovalGranted",
			payload: { by: "klyne", override: true, level: "LOW", verdictName: verdict?.name },
		});
		const approval = await approveRun(repo, 1, human);
		expect(approval.decision).toBe("approved");
		expect(await readApproval(repo, 1)).not.toBeNull();
	});

	it("refuses a conflicting decision when the event log already recorded the opposite outcome", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		await appendEvent(rptDirOf(repo), 1, {
			ts: new Date().toISOString(),
			source: "rpt",
			kind: "ApprovalGranted",
			payload: { by: "klyne", override: true, level: "LOW", verdictName: verdict?.name },
		});
		await expect(rejectRun(repo, 1, human)).rejects.toThrow();
	});
});

describe("readApproval", () => {
	it("returns null when no decision has been recorded", async () => {
		expect(await readApproval(await verifiedRepo(), 1)).toBeNull();
	});

	it("re-derives override from the verdict rather than trusting the stored value", async () => {
		const repo = await verifiedRepo();
		await approveRun(repo, 1, human);
		const stored = await readApproval(repo, 1);
		const verdict = await readVerdict(repo, 1);
		expect(stored?.override).toBe(verdict?.name !== "VERIFIED");
	});
});

describe("isConfirmed", () => {
	it("accepts the exact confirmation token", () => {
		expect(isConfirmed("yes")).toBe(true);
	});

	it("trims surrounding whitespace", () => {
		expect(isConfirmed("  yes\n")).toBe(true);
	});

	it("rejects anything else, including a near miss", () => {
		expect(isConfirmed("Yes")).toBe(false);
		expect(isConfirmed("y")).toBe(false);
		expect(isConfirmed("")).toBe(false);
	});
});

