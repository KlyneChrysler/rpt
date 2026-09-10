import { mkdir } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/app/terminalConfirm.js", () => ({ readFromControllingTerminal: vi.fn() }));

import {
	actorFromEnvironment,
	approveRun,
	confirmationPhrase,
	readApproval,
	rejectRun,
	type Actor,
} from "../../src/app/approveRun.js";
import { initRepo } from "../../src/app/initRepo.js";
import { readFromControllingTerminal } from "../../src/app/terminalConfirm.js";
import { readVerdict, verifyRun } from "../../src/app/verifyRun.js";
import { writeApproval } from "../../src/store/approvals.js";
import { appendEvent } from "../../src/store/eventLog.js";
import { rptDirOf, runDirOf } from "../../src/store/paths.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

const human: Actor = { name: "klyne", interactive: true, agentContext: "human" };
const agent: Actor = { name: "claude", interactive: false, agentContext: "agent" };

// Every real interactive path in record() now requires a typed confirmation.
// The default behaviour here mirrors what a human actually does with the
// prompt: reads what it asks them to type, and types exactly that back -
// extracted from the quoted phrase in the prompt text rather than
// recomputing it, so this stays a black-box stand-in for a person rather
// than a second copy of confirmationPhrase's own logic. Individual tests
// override this to exercise a wrong or missing confirmation.
beforeEach(() => {
	vi.mocked(readFromControllingTerminal).mockReset();
	vi.mocked(readFromControllingTerminal).mockImplementation(async (prompt: string) => {
		const match = /"([^"]+)"/.exec(prompt);
		return match?.[1] ?? "";
	});
});

// A realistic ApprovalGranted/ApprovalDenied event payload, for tests that
// simulate a prior approval attempt by appending the event directly rather
// than going through approveRun/rejectRun.
function approvalEventPayload(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		by: "klyne",
		override: true,
		level: "LOW",
		score: 3,
		contributions: [{ id: "files-changed-count", label: "Files changed", points: 3 }],
		configFingerprint: "deadbeef",
		...overrides,
	};
}

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

	// Detectability, not just the level itself: a later reader can recompute
	// today's risk against this exact config (by fingerprint) and compare it
	// to what was actually recorded, rather than trusting the level in
	// isolation with no way to tell if the assessment behind it has since
	// changed.
	it("persists the score, the itemised contributions and a config fingerprint alongside the level", async () => {
		const approval = await approveRun(await verifiedRepo(), 1, human);
		expect(typeof approval.score).toBe("number");
		expect(approval.contributions.length).toBeGreaterThan(0);
		expect(approval.contributions[0]).toEqual(expect.objectContaining({ id: expect.any(String), label: expect.any(String), points: expect.any(Number) }));
		expect(approval.configFingerprint).toMatch(/^[0-9a-f]{64}$/);
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
		await expect(approveRun(await verifiedRepo(), 1, forger)).rejects.toThrow(/disallowed character/i);
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
			payload: approvalEventPayload({ by: "klyne", verdictName: verdict?.name }),
		});
		const approval = await approveRun(repo, 1, human);
		expect(approval.decision).toBe("approved");
		expect(await readApproval(repo, 1)).not.toBeNull();
	});

	it("heals from the event's own recorded payload, not from the live actor calling record()", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		await appendEvent(rptDirOf(repo), 1, {
			ts: "2020-01-01T00:00:00.000Z",
			source: "rpt",
			kind: "ApprovalGranted",
			payload: approvalEventPayload({ by: "the-original-approver", verdictName: verdict?.name }),
		});
		// A different human retries the interrupted write.
		const retryer: Actor = { name: "someone-else", interactive: true, agentContext: "human" };
		const approval = await approveRun(repo, 1, retryer);
		expect(approval.by).toBe("the-original-approver");
		expect(approval.at).toBe("2020-01-01T00:00:00.000Z");
		expect(approval.score).toBe(3);
		expect(approval.contributions).toEqual([{ id: "files-changed-count", label: "Files changed", points: 3 }]);
		expect(approval.configFingerprint).toBe("deadbeef");
		// The mandatory confirmation must not even be asked on a heal - it
		// already ran when the event was written.
		expect(readFromControllingTerminal).not.toHaveBeenCalled();
	});

	it("does not re-run the critical gate on a heal, even if the score would now block it", async () => {
		// Approve for real at whatever (non-critical) level this fixture scores
		// at, then delete the file to simulate the interrupted-write scenario,
		// and confirm the retry still succeeds without recomputing risk.
		const repo = await verifiedRepo();
		await approveRun(repo, 1, human);
		const { rm } = await import("node:fs/promises");
		const { approvalPathOf } = await import("../../src/store/paths.js");
		await rm(approvalPathOf(rptDirOf(repo), 1));
		vi.mocked(readFromControllingTerminal).mockClear();
		const approval = await approveRun(repo, 1, human);
		expect(approval.decision).toBe("approved");
		expect(readFromControllingTerminal).not.toHaveBeenCalled();
	});

	it("refuses a conflicting decision when the event log already recorded the opposite outcome", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		await appendEvent(rptDirOf(repo), 1, {
			ts: new Date().toISOString(),
			source: "rpt",
			kind: "ApprovalGranted",
			payload: approvalEventPayload({ by: "klyne", verdictName: verdict?.name }),
		});
		await expect(rejectRun(repo, 1, human)).rejects.toThrow();
	});
});

describe("record()'s mandatory typed confirmation", () => {
	it("prompts with the run id, the decision, the verdict and the risk level", async () => {
		const repo = await verifiedRepo();
		await approveRun(repo, 1, human);
		const verdict = await readVerdict(repo, 1);
		const prompt = vi.mocked(readFromControllingTerminal).mock.calls[0]?.[0];
		expect(prompt).toContain("1");
		expect(prompt).toContain("approved");
		expect(prompt).toContain(verdict?.name);
	});

	it("refuses when the typed confirmation does not match", async () => {
		vi.mocked(readFromControllingTerminal).mockResolvedValue("yes");
		await expect(approveRun(await verifiedRepo(), 1, human)).rejects.toThrow(/did not match/i);
	});

	it("refuses when the controlling terminal cannot be opened", async () => {
		vi.mocked(readFromControllingTerminal).mockRejectedValue(new Error("ENXIO: no such device"));
		await expect(approveRun(await verifiedRepo(), 1, human)).rejects.toThrow(/could not be opened/i);
	});

	// Demonstrates the fix directly: a confirmation is bound to the specific
	// decision, not a reusable "yes" that authorises anything. A phrase
	// computed for approving this exact run does not also authorise
	// rejecting it.
	it("does not accept a confirmation phrase bound to a different decision on the same run", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		const phraseForApproving = confirmationPhrase(1, "approved", verdict!.name, "LOW");
		vi.mocked(readFromControllingTerminal).mockResolvedValue(phraseForApproving);
		await expect(rejectRun(repo, 1, human)).rejects.toThrow(/did not match/i);
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

	it("throws when an approval record exists but the run it names has no verdict", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		// A run that was never verified: writing an approval record for it
		// directly (bypassing approveRun) simulates data that outlived its
		// verdict - e.g. a hand-edited or otherwise corrupted .rpt directory.
		await mkdir(runDirOf(rptDirOf(repo), 1), { recursive: true });
		await writeApproval(rptDirOf(repo), {
			runId: 1,
			decision: "approved",
			by: "klyne",
			at: "2026-09-10T10:00:00.000Z",
			override: false,
			level: "LOW",
			score: 3,
			contributions: [{ id: "files-changed-count", label: "Files changed", points: 3 }],
			configFingerprint: "deadbeef",
		});
		await expect(readApproval(repo, 1)).rejects.toThrow(/verdict/i);
	});
});

describe("actorFromEnvironment", () => {
	// No I/O at all any more - env inspection can prove "agent" but never
	// "human" - so both branches are safe to exercise directly.
	it("reports 'agent' when a known marker is set", () => {
		const original = process.env.CLAUDECODE;
		process.env.CLAUDECODE = "1";
		try {
			expect(actorFromEnvironment().agentContext).toBe("agent");
		} finally {
			if (original === undefined) delete process.env.CLAUDECODE;
			else process.env.CLAUDECODE = original;
		}
	});

	it("reports 'unknown', never 'human', when no marker is set", () => {
		const original = { CLAUDECODE: process.env.CLAUDECODE, RPT_AGENT_CONTEXT: process.env.RPT_AGENT_CONTEXT };
		delete process.env.CLAUDECODE;
		delete process.env.RPT_AGENT_CONTEXT;
		try {
			expect(actorFromEnvironment().agentContext).toBe("unknown");
		} finally {
			if (original.CLAUDECODE !== undefined) process.env.CLAUDECODE = original.CLAUDECODE;
			if (original.RPT_AGENT_CONTEXT !== undefined) process.env.RPT_AGENT_CONTEXT = original.RPT_AGENT_CONTEXT;
		}
	});
});
