import { describe, expect, it } from "vitest";
import { approveRun, rejectRun, type Actor } from "../../src/app/approveRun.js";
import { initRepo } from "../../src/app/initRepo.js";
import { verifyRun } from "../../src/app/verifyRun.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

const human: Actor = { name: "klyne", interactive: true, agentContext: false };
const agent: Actor = { name: "claude", interactive: false, agentContext: true };

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

describe("approveRun", () => {
	it("records an approval by a human at a terminal", async () => {
		const approval = await approveRun(await verifiedRepo(), 1, human);
		expect(approval.decision).toBe("approved");
		expect(approval.by).toBe("klyne");
	});

	it("refuses an actor running inside an agent context", async () => {
		await expect(approveRun(await verifiedRepo(), 1, agent)).rejects.toThrow(/human/i);
	});

	it("refuses a non-interactive actor even outside an agent context", async () => {
		const piped: Actor = { name: "ci", interactive: false, agentContext: false };
		await expect(approveRun(await verifiedRepo(), 1, piped)).rejects.toThrow(/terminal/i);
	});

	it("marks approval of an unverified run as an override", async () => {
		const approval = await approveRun(await verifiedRepo(), 1, human);
		expect(approval.override).toBe(true);
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
});
