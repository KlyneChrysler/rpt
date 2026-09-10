import { describe, expect, it } from "vitest";
import { initRepo } from "../../src/app/initRepo.js";
import { dashboardModel, runDetailModel } from "../../src/app/readModel.js";
import { verifyRun } from "../../src/app/verifyRun.js";
import { allocateRunId } from "../../src/store/runIndex.js";
import { rptDirOf } from "../../src/store/paths.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

async function repoWithVerifiedRun(): Promise<string> {
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

describe("dashboardModel", () => {
	it("is empty for a repo with no runs", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		expect((await dashboardModel(repo)).runs).toEqual([]);
	});

	it("summarises each run with its risk band", async () => {
		const model = await dashboardModel(await repoWithVerifiedRun());
		expect(model.runs).toHaveLength(1);
		expect(model.runs[0]?.riskLevel).toMatch(/LOW|MEDIUM|HIGH|CRITICAL/);
	});

	it("reports a null risk for a run that has not been verified", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		await driveFakeAgent(repo, [{ kind: "start", transcriptPath: null }, { kind: "stop" }]);
		expect((await dashboardModel(repo)).runs[0]?.riskScore).toBeNull();
	});

	it("returns plain serialisable data", async () => {
		const model = await dashboardModel(await repoWithVerifiedRun());
		expect(() => structuredClone(model)).not.toThrow();
	});

	it("lists a run it cannot project, with the reason, rather than dropping or throwing", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		await allocateRunId(rptDirOf(repo));
		const runs = (await dashboardModel(repo)).runs;
		expect(runs).toHaveLength(1);
		expect(runs[0]?.unprojectable).toContain("RunStarted");
	});
});

describe("runDetailModel", () => {
	it("carries the run, its verdict, its risk and its events", async () => {
		const model = await runDetailModel(await repoWithVerifiedRun(), 1);
		expect(model.run.id).toBe(1);
		expect(model.verdict?.name).toBeDefined();
		expect(model.risk?.contributions.length).toBeGreaterThan(0);
		expect(model.events.length).toBeGreaterThan(0);
	});

	it("names unpriced models rather than reporting a wrong cost", async () => {
		const model = await runDetailModel(await repoWithVerifiedRun(), 1);
		expect(model.costUsd).toBeNull();
		expect(model.unpricedModels).toEqual([]);
	});

	it("has a null approval until a human decides", async () => {
		expect((await runDetailModel(await repoWithVerifiedRun(), 1)).approval).toBeNull();
	});

	it("has a null risk for a run with no verdict", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		await driveFakeAgent(repo, [{ kind: "start", transcriptPath: null }, { kind: "stop" }]);
		expect((await runDetailModel(repo, 1)).risk).toBeNull();
	});
});
