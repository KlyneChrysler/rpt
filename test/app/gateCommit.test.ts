import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/app/terminalConfirm.js", () => ({ readFromControllingTerminal: vi.fn() }));

import { approveRun, rejectRun, type Actor } from "../../src/app/approveRun.js";
import { gateCommit } from "../../src/app/gateCommit.js";
import { initRepo } from "../../src/app/initRepo.js";
import { readFromControllingTerminal } from "../../src/app/terminalConfirm.js";
import { loadRun } from "../../src/app/loadRun.js";
import { readVerdict, verifyRun } from "../../src/app/verifyRun.js";
import { assessRun } from "../../src/app/assessRun.js";
import { fingerprintOf } from "../../src/domain/checksum.js";
import { writeApproval } from "../../src/store/approvals.js";
import { readEvents } from "../../src/store/eventLog.js";
import { rptDirOf } from "../../src/store/paths.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

const human: Actor = { name: "klyne", interactive: true, agentContext: "human" };

// Stands in for a person reading the prompt and typing back exactly what it
// asks for, the same way test/app/approveRun.test.ts does.
beforeEach(() => {
	vi.mocked(readFromControllingTerminal).mockReset();
	vi.mocked(readFromControllingTerminal).mockImplementation(async (prompt: string) => /"([^"]+)"/.exec(prompt)?.[1] ?? "");
});

afterEach(() => {
	delete process.env.RPT_BYPASS;
});

async function repoWithRun(config: Record<string, unknown>, path = "a.ts"): Promise<string> {
	const repo = await makeFixtureRepo();
	await initRepo(repo);
	// Written before the run starts, because a run's config snapshot - the one
	// every later assessment judges it by - is taken at RunStarted.
	await writeFile(join(repo, "rpt.config.json"), JSON.stringify(config));
	await driveFakeAgent(repo, [
		{ kind: "start", transcriptPath: null },
		{ kind: "edit", path, body: "export const a = 1;\n" },
		{ kind: "stop" },
	]);
	return repo;
}

// The gate refuses to approve a CRITICAL run, and so does approveRun, so a
// critical run with a decision already on file has to be built by writing the
// record the way an earlier, lower-risk assessment would have.
async function forceApprovalRecord(repo: string): Promise<void> {
	const run = await loadRun(repo, 1);
	const verdict = await verifyRun(repo, 1);
	const { assessment, config } = await assessRun(repo, run, verdict);
	await writeApproval(rptDirOf(repo), {
		runId: 1,
		decision: "approved",
		by: "klyne",
		at: new Date().toISOString(),
		override: verdict.name !== "VERIFIED",
		level: assessment.level,
		score: assessment.score,
		contributions: assessment.contributions,
		configFingerprint: fingerprintOf(config),
	});
}

describe("gateCommit", () => {
	it("allows a commit when there is no active run", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		const outcome = await gateCommit(repo);
		expect(outcome.allowed).toBe(true);
		expect(outcome.exitCode).toBe(0);
	});

	it("verifies the run itself when it has not been verified", async () => {
		const repo = await repoWithRun({ testCommand: "exit 0" });
		await gateCommit(repo);
		expect(await readVerdict(repo, 1)).not.toBeNull();
	});

	it("blocks an unverified run and names the approval command", async () => {
		const repo = await repoWithRun({});
		const outcome = await gateCommit(repo);
		expect(outcome.allowed).toBe(false);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.message).toContain("rpt approve 1");
	});

	it("allows the commit once a human has approved", async () => {
		const repo = await repoWithRun({});
		await verifyRun(repo, 1);
		await approveRun(repo, 1, human);
		expect((await gateCommit(repo)).allowed).toBe(true);
	});

	it("keeps blocking after a rejection", async () => {
		const repo = await repoWithRun({});
		await verifyRun(repo, 1);
		await rejectRun(repo, 1, human);
		const outcome = await gateCommit(repo);
		expect(outcome.allowed).toBe(false);
		expect(outcome.message).toMatch(/rejected/i);
	});

	it("blocks a critical run even with an approval on file", async () => {
		const repo = await repoWithRun({ thresholds: { review: 1, approval: 2, block: 3 } }, "auth-keys.ts");
		await forceApprovalRecord(repo);
		const outcome = await gateCommit(repo);
		expect(outcome.allowed).toBe(false);
		expect(outcome.message).toMatch(/critical/i);
	});

	it("refuses to let the bypass clear a critical run", async () => {
		const repo = await repoWithRun({ thresholds: { review: 1, approval: 2, block: 3 } }, "auth-keys.ts");
		process.env.RPT_BYPASS = "1";
		expect((await gateCommit(repo)).allowed).toBe(false);
	});

	it("records the bypass rather than staying silent", async () => {
		const repo = await repoWithRun({});
		process.env.RPT_BYPASS = "1";
		const outcome = await gateCommit(repo);
		expect(outcome.allowed).toBe(true);
		const { events } = await readEvents(rptDirOf(repo), 1);
		expect(events.some((event) => event.payload.bypass === true)).toBe(true);
	});

	it("does not call an approved commit a bypass just because the variable is set", async () => {
		const repo = await repoWithRun({});
		await verifyRun(repo, 1);
		await approveRun(repo, 1, human);
		process.env.RPT_BYPASS = "1";
		await gateCommit(repo);
		const { events } = await readEvents(rptDirOf(repo), 1);
		expect(events.some((event) => event.payload.bypass === true)).toBe(false);
	});

	it("records the score it judged at on its own gate event", async () => {
		const repo = await repoWithRun({});
		await gateCommit(repo);
		const { events } = await readEvents(rptDirOf(repo), 1);
		const requested = events.find((event) => event.kind === "ApprovalRequested");
		expect(typeof requested?.payload.score).toBe("number");
		expect(requested?.payload.level).toMatch(/LOW|MEDIUM|HIGH|CRITICAL/);
	});

	// verifyRun records one when it produces a verdict. The gate re-derives for
	// its own decision but must not record a second identical one a millisecond
	// later, which reads as a bug on the timeline and says nothing new.
	it("does not add a second RiskAssessed for the verification it just triggered", async () => {
		const repo = await repoWithRun({});
		await gateCommit(repo);
		const { events } = await readEvents(rptDirOf(repo), 1);
		expect(events.filter((event) => event.kind === "RiskAssessed")).toHaveLength(1);
	});

	it("writes risk.json beside the verdict, bound to what it was derived from", async () => {
		const repo = await repoWithRun({});
		await gateCommit(repo);
		const { readRiskAssessment } = await import("../../src/store/risk.js");
		const record = await readRiskAssessment(rptDirOf(repo), 1);
		expect(record?.runId).toBe(1);
		expect(record?.verdictName).toBe("UNVERIFIED");
		expect(record?.configFingerprint).toMatch(/^[0-9a-f]{64}$/);
	});

	// The gate re-derives on every call. A hand-edited risk.json claiming LOW
	// must not be able to lower the level anybody is judged at.
	it("re-derives rather than reading risk.json back, so an edited copy cannot lower the gate", async () => {
		const repo = await repoWithRun({});
		await gateCommit(repo);
		const { writeRiskAssessment, readRiskAssessment } = await import("../../src/store/risk.js");
		const real = await readRiskAssessment(rptDirOf(repo), 1);
		await writeRiskAssessment(rptDirOf(repo), { ...real!, score: 0, level: "LOW", contributions: [] });
		expect((await gateCommit(repo)).allowed).toBe(false);
	});

	it("leaves the run loadable and ungapped after gating", async () => {
		const repo = await repoWithRun({});
		await gateCommit(repo);
		const run = await loadRun(repo, 1);
		expect(run.hasGaps).toBe(false);
		// VerifierCompleted is a no-op in the fold and nothing else transitions a
		// run to its verdict name, so a verified-but-undecided run projects as
		// VERIFYING. What matters here is that the gate's own event did not gap it.
		expect(run.state).toBe("VERIFYING");
	});
});
