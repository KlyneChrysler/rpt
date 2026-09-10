import { mkdir } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/app/terminalConfirm.js", () => ({ readFromControllingTerminal: vi.fn() }));

import {
	actorFromEnvironment,
	approveRun,
	confirmationPhrase,
	healApproval,
	readApproval,
	rejectRun,
	type Actor,
} from "../../src/app/approveRun.js";
import { initRepo } from "../../src/app/initRepo.js";
import { readFromControllingTerminal } from "../../src/app/terminalConfirm.js";
import { readVerdict, verifyRun } from "../../src/app/verifyRun.js";
import { DEFAULT_CONFIG } from "../../src/config/load.js";
import { fingerprintOf } from "../../src/domain/checksum.js";
import { writeApproval } from "../../src/store/approvals.js";
import { appendEvent, MAX_PAYLOAD_BYTES } from "../../src/store/eventLog.js";
import { rptDirOf, runDirOf } from "../../src/store/paths.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

const human: Actor = { name: "klyne", interactive: true, agentContext: "human" };
const agent: Actor = { name: "claude", interactive: false, agentContext: "agent" };

// The fixtures below never touch rpt.config.json, so every real assessment
// against them - and therefore every recorded event's own configFingerprint
// - is DEFAULT_CONFIG's. Used as the default here so a forged-event test
// that does not care about the fingerprint check still passes it, the same
// way a real event would.
const REAL_CONFIG_FINGERPRINT = fingerprintOf(DEFAULT_CONFIG);

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
		configFingerprint: REAL_CONFIG_FINGERPRINT,
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

	// An actor whose agent context could not be determined is no longer
	// refused outright: it falls through to the mandatory typed confirmation,
	// which is unconditional, decision-bound proof - stronger than the old
	// environment pre-check, and satisfiable by an honest human caller, which
	// hard-refusing "unknown" was not (see the comment on AgentContextSignal
	// in src/app/approveRun.ts for the full reasoning).
	it("lets an actor whose agent context could not be determined proceed to, and succeed at, the mandatory confirmation", async () => {
		const uncertain: Actor = { name: "?", interactive: true, agentContext: "unknown" };
		const approval = await approveRun(await verifiedRepo(), 1, uncertain);
		expect(approval.decision).toBe("approved");
	});

	it("still refuses an actor whose agent context could not be determined if the confirmation does not match", async () => {
		vi.mocked(readFromControllingTerminal).mockResolvedValue("yes");
		const uncertain: Actor = { name: "?", interactive: true, agentContext: "unknown" };
		await expect(approveRun(await verifiedRepo(), 1, uncertain)).rejects.toThrow(/did not match/i);
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

	// Healing is no longer something approveRun/rejectRun fall into: a run
	// whose event log already shows this exact outcome, with no file on
	// disk, is now refused by the same state-precondition check that refuses
	// any other illegal transition - recovering it is healApproval's job,
	// an operation a person has to choose explicitly. See the
	// describe("healApproval", ...) block below for the actual recovery
	// tests.
	it("no longer implicitly heals: refuses rather than silently recovering when the event already recorded this exact outcome", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		await appendEvent(rptDirOf(repo), 1, {
			ts: new Date().toISOString(),
			source: "rpt",
			kind: "ApprovalGranted",
			payload: approvalEventPayload({ by: "klyne", verdictName: verdict?.name }),
		});
		await expect(approveRun(repo, 1, human)).rejects.toThrow();
		expect(await readApproval(repo, 1)).toBeNull();
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

	// The wedge this closes: a single junk approval-kind event (here, one
	// naming a verdict the fold does not recognise, so it gaps rather than
	// applies) used to permanently block every future decision - record()
	// refused with "already has a recorded decision" (false: nothing had
	// actually been recorded) and healApproval separately refused with
	// "nothing to recover" (true, but leaving no path forward either way). A
	// genuine decision now proceeds past a junk event rather than deferring
	// to it.
	it("proceeds past a junk approval event the fold already rejected, rather than being wedged by it", async () => {
		const repo = await verifiedRepo();
		await appendEvent(rptDirOf(repo), 1, {
			ts: new Date().toISOString(),
			source: "rpt",
			kind: "ApprovalGranted",
			payload: approvalEventPayload({ by: "klyne", verdictName: "NONSENSE" }),
		});
		const approval = await approveRun(repo, 1, human);
		expect(approval.decision).toBe("approved");
	});
});

describe("healApproval", () => {
	// A crash between the event append (source of truth) succeeding and the
	// approval.json write failing must be recoverable: healApproval, called
	// deliberately, completes the missing write rather than the run being
	// stuck with an event but no file forever.
	it("heals a missing approval file when the granting event was already recorded", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		await appendEvent(rptDirOf(repo), 1, {
			ts: new Date().toISOString(),
			source: "rpt",
			kind: "ApprovalGranted",
			payload: approvalEventPayload({ by: "klyne", verdictName: verdict?.name }),
		});
		const approval = await healApproval(repo, 1, human, "approved");
		expect(approval.decision).toBe("approved");
		expect(await readApproval(repo, 1)).not.toBeNull();
	});

	// The Critical this round found: splitting healing out of record() moved
	// the actor argument, assertHuman, the approver allowlist and the typed
	// confirmation onto only the recording half. healApproval had none of
	// them - an agent context, no terminal and a terminal reader rigged to
	// throw were all still enough to heal a forged event. It now takes the
	// same Actor and runs the same checks.
	it("refuses an actor running inside a known agent context, even with a real event to heal from", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		await appendEvent(rptDirOf(repo), 1, {
			ts: new Date().toISOString(),
			source: "rpt",
			kind: "ApprovalGranted",
			payload: approvalEventPayload({ by: "klyne", verdictName: verdict?.name }),
		});
		await expect(healApproval(repo, 1, agent, "approved")).rejects.toThrow(/human/i);
		expect(await readApproval(repo, 1)).toBeNull();
	});

	it("refuses an invalid approver name on the healing call, even with a real event to heal from", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		await appendEvent(rptDirOf(repo), 1, {
			ts: new Date().toISOString(),
			source: "rpt",
			kind: "ApprovalGranted",
			payload: approvalEventPayload({ by: "klyne", verdictName: verdict?.name }),
		});
		const forger: Actor = { name: "klyne\nrpt: FORGED LINE", interactive: true, agentContext: "human" };
		await expect(healApproval(repo, 1, forger, "approved")).rejects.toThrow(/disallowed character/i);
	});

	// Inverted from the previous round's assertion that the confirmation was
	// never read on a heal - that was true only because healing had no
	// confirmation at all. It now requires one, bound to the *recorded*
	// level and verdict (not a fresh assessment, which would break the
	// never-re-judge rule).
	it("requires the mandatory typed confirmation, bound to the recorded level and verdict, to heal", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		await appendEvent(rptDirOf(repo), 1, {
			ts: "2020-01-01T00:00:00.000Z",
			source: "rpt",
			kind: "ApprovalGranted",
			payload: approvalEventPayload({ by: "the-original-approver", level: "LOW", verdictName: verdict?.name }),
		});
		await healApproval(repo, 1, human, "approved");
		expect(readFromControllingTerminal).toHaveBeenCalledTimes(1);
		const prompt = vi.mocked(readFromControllingTerminal).mock.calls[0]?.[0];
		expect(prompt).toContain("approved");
		expect(prompt).toContain(verdict?.name);
		expect(prompt).toContain("LOW");
	});

	it("refuses to heal when the typed confirmation does not match", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		await appendEvent(rptDirOf(repo), 1, {
			ts: new Date().toISOString(),
			source: "rpt",
			kind: "ApprovalGranted",
			payload: approvalEventPayload({ by: "klyne", verdictName: verdict?.name }),
		});
		vi.mocked(readFromControllingTerminal).mockResolvedValue("yes");
		await expect(healApproval(repo, 1, human, "approved")).rejects.toThrow(/did not match/i);
		expect(await readApproval(repo, 1)).toBeNull();
	});

	it("heals from the event's own recorded payload, not from any live input", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		await appendEvent(rptDirOf(repo), 1, {
			ts: "2020-01-01T00:00:00.000Z",
			source: "rpt",
			kind: "ApprovalGranted",
			payload: approvalEventPayload({ by: "the-original-approver", verdictName: verdict?.name }),
		});
		// A different human confirms the recovery; the record still names the
		// original approver, not whoever completed the write.
		const retryer: Actor = { name: "someone-else", interactive: true, agentContext: "human" };
		const approval = await healApproval(repo, 1, retryer, "approved");
		expect(approval.by).toBe("the-original-approver");
		expect(approval.at).toBe("2020-01-01T00:00:00.000Z");
		expect(approval.score).toBe(3);
		expect(approval.contributions).toEqual([{ id: "files-changed-count", label: "Files changed", points: 3 }]);
		expect(approval.configFingerprint).toBe(REAL_CONFIG_FINGERPRINT);
	});

	it("does not re-run the critical gate, even if today's live score would now block it", async () => {
		// Grants a real approval at whatever (non-critical) level this fixture
		// scores at, removes the file to simulate the interrupted-write
		// scenario, and confirms healing still succeeds without recomputing
		// risk against today's inputs.
		const repo = await verifiedRepo();
		await approveRun(repo, 1, human);
		const { rm } = await import("node:fs/promises");
		const { approvalPathOf } = await import("../../src/store/paths.js");
		await rm(approvalPathOf(rptDirOf(repo), 1));
		const approval = await healApproval(repo, 1, human, "approved");
		expect(approval.decision).toBe("approved");
	});

	// The Critical this round found: the old implicit heal reconstructed an
	// approval from whatever the event claimed, with no gate at all. A
	// forged event - one written directly to the event log rather than
	// through approveRun, exactly what an agent with repository write access
	// can already do - claiming CRITICAL risk must still be refused here,
	// the same way a fresh approval attempt would be.
	it("refuses to heal an approval whose recorded event claims CRITICAL risk", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		await appendEvent(rptDirOf(repo), 1, {
			ts: new Date().toISOString(),
			source: "rpt",
			kind: "ApprovalGranted",
			payload: approvalEventPayload({ by: "attacker-forged-name", level: "CRITICAL", verdictName: verdict?.name }),
		});
		await expect(healApproval(repo, 1, human, "approved")).rejects.toThrow(/CRITICAL/);
		expect(await readApproval(repo, 1)).toBeNull();
	});

	it("still allows healing a rejection whose recorded event claims CRITICAL risk - refusing is not a sign-off", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		await appendEvent(rptDirOf(repo), 1, {
			ts: new Date().toISOString(),
			source: "rpt",
			kind: "ApprovalDenied",
			payload: approvalEventPayload({ by: "klyne", level: "CRITICAL", verdictName: verdict?.name }),
		});
		const rejection = await healApproval(repo, 1, human, "rejected");
		expect(rejection.decision).toBe("rejected");
	});

	// The other half of the Critical: a forged event naming a verdict this
	// run was never actually decided against must also be refused, not
	// silently trusted because it happens to sit at this run's own path.
	it("refuses to heal an approval whose recorded event names a different verdict than the one on disk", async () => {
		const repo = await verifiedRepo();
		const realVerdictName = (await readVerdict(repo, 1))?.name;
		const wrongVerdictName = realVerdictName === "FAILED" ? "VERIFIED" : "FAILED";
		await appendEvent(rptDirOf(repo), 1, {
			ts: new Date().toISOString(),
			source: "rpt",
			kind: "ApprovalGranted",
			payload: approvalEventPayload({ by: "klyne", verdictName: wrongVerdictName }),
		});
		await expect(healApproval(repo, 1, human, "approved")).rejects.toThrow(/verdict/i);
		expect(await readApproval(repo, 1)).toBeNull();
	});

	// Derived from the verdict on disk, not copied from the event's own
	// override claim - a forged event could claim override: false for a run
	// that was never VERIFIED.
	it("derives override from the verdict on disk rather than trusting the event's own claim", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		expect(verdict?.name).not.toBe("VERIFIED");
		await appendEvent(rptDirOf(repo), 1, {
			ts: new Date().toISOString(),
			source: "rpt",
			kind: "ApprovalGranted",
			// Falsely claims override: false even though the verdict on disk is
			// not VERIFIED.
			payload: approvalEventPayload({ by: "klyne", override: false, verdictName: verdict?.name }),
		});
		const approval = await healApproval(repo, 1, human, "approved");
		expect(approval.override).toBe(true);
	});

	it("refuses to heal an event with a malformed timestamp", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		await appendEvent(rptDirOf(repo), 1, {
			ts: "2020-01-01T00:00:00.000Z\nrpt: FORGED LINE",
			source: "rpt",
			kind: "ApprovalGranted",
			payload: approvalEventPayload({ by: "klyne", verdictName: verdict?.name }),
		});
		await expect(healApproval(repo, 1, human, "approved")).rejects.toThrow();
		expect(await readApproval(repo, 1)).toBeNull();
	});

	// The fields the record exists to make drift detectable with are not
	// trusted just because they have the right JavaScript type: "any string
	// as a config fingerprint, any score, an empty contribution set" is
	// exactly what the recorder could never have written.
	it("refuses a config fingerprint that is not a real fingerprint's shape", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		await appendEvent(rptDirOf(repo), 1, {
			ts: new Date().toISOString(),
			source: "rpt",
			kind: "ApprovalGranted",
			payload: approvalEventPayload({ by: "klyne", configFingerprint: "not-a-real-fingerprint", verdictName: verdict?.name }),
		});
		await expect(healApproval(repo, 1, human, "approved")).rejects.toThrow();
		expect(await readApproval(repo, 1)).toBeNull();
	});

	it("refuses a config fingerprint that has the right shape but matches neither the run's own fingerprint nor a current resolve", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		const someOtherRealLookingFingerprint = fingerprintOf({ not: "this run's config" });
		await appendEvent(rptDirOf(repo), 1, {
			ts: new Date().toISOString(),
			source: "rpt",
			kind: "ApprovalGranted",
			payload: approvalEventPayload({ by: "klyne", configFingerprint: someOtherRealLookingFingerprint, verdictName: verdict?.name }),
		});
		await expect(healApproval(repo, 1, human, "approved")).rejects.toThrow(/fingerprint/i);
		expect(await readApproval(repo, 1)).toBeNull();
	});

	it("refuses a score outside the [0, 100] range assessRisk can ever produce", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		await appendEvent(rptDirOf(repo), 1, {
			ts: new Date().toISOString(),
			source: "rpt",
			kind: "ApprovalGranted",
			payload: approvalEventPayload({ by: "klyne", score: 1000, verdictName: verdict?.name }),
		});
		await expect(healApproval(repo, 1, human, "approved")).rejects.toThrow();
		expect(await readApproval(repo, 1)).toBeNull();
	});

	it("refuses an empty contributions array - a real assessment always contributes at least one entry", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		await appendEvent(rptDirOf(repo), 1, {
			ts: new Date().toISOString(),
			source: "rpt",
			kind: "ApprovalGranted",
			payload: approvalEventPayload({ by: "klyne", contributions: [], verdictName: verdict?.name }),
		});
		await expect(healApproval(repo, 1, human, "approved")).rejects.toThrow();
		expect(await readApproval(repo, 1)).toBeNull();
	});

	it("refuses when there is nothing to heal", async () => {
		await expect(healApproval(await verifiedRepo(), 1, human, "approved")).rejects.toThrow(/nothing to recover/i);
	});

	it("refuses to heal a run twice", async () => {
		const repo = await verifiedRepo();
		const verdict = await readVerdict(repo, 1);
		await appendEvent(rptDirOf(repo), 1, {
			ts: new Date().toISOString(),
			source: "rpt",
			kind: "ApprovalGranted",
			payload: approvalEventPayload({ by: "klyne", verdictName: verdict?.name }),
		});
		await healApproval(repo, 1, human, "approved");
		await expect(healApproval(repo, 1, human, "approved")).rejects.toThrow(/already/i);
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

describe("approval event payload size", () => {
	// eventLog.ts's capPayload degrades any payload over MAX_PAYLOAD_BYTES,
	// which for this event kind means healApproval loses the
	// score/contributions/configFingerprint it needs and refuses rather than
	// recovers. This pins the headroom with a worst-case payload - every
	// current risk rule contributing, at its longest realistic field
	// lengths - rather than only asserting it against whatever a single test
	// fixture's real assessment happens to produce.
	it("stays under the event payload cap even with every risk rule contributing", async () => {
		const { DEFAULT_RULES } = await import("../../src/risk/rules.js");
		const contributions = DEFAULT_RULES.map((rule) => ({ id: rule.id, label: rule.label, points: 100 }));
		const payload = {
			by: "a".repeat(200), // domain/approval.ts's APPROVER_NAME_MAX_LENGTH
			override: true,
			level: "CRITICAL",
			score: 100,
			contributions,
			configFingerprint: "a".repeat(64), // sha256 hex digest length
			verdictName: "UNVERIFIED",
		};
		const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
		expect(bytes).toBeLessThan(MAX_PAYLOAD_BYTES);
	});
});
