import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidRiskRecordError, readRiskAssessment, writeRiskAssessment, type RecordedRiskAssessment } from "../../src/store/risk.js";
import { riskPathOf } from "../../src/store/paths.js";

const record: RecordedRiskAssessment = {
	runId: 1,
	score: 47,
	level: "MEDIUM",
	contributions: [{ id: "sensitive-auth", label: "Authentication or authorization paths modified", points: 25 }],
	verdictName: "VERIFIED",
	configFingerprint: "a".repeat(64),
	assessedAt: "2026-09-10T10:00:00.000Z",
};

async function rptDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "rpt-riskstore-"));
}

describe("risk record store", () => {
	it("round trips an assessment", async () => {
		const dir = await rptDir();
		await writeRiskAssessment(dir, record);
		expect(await readRiskAssessment(dir, 1)).toEqual(record);
	});

	it("is null for a run that has never been assessed", async () => {
		expect(await readRiskAssessment(await rptDir(), 1)).toBeNull();
	});

	it("carries the verdict and config it was derived from, so a stale copy is detectable", async () => {
		const dir = await rptDir();
		await writeRiskAssessment(dir, record);
		const read = await readRiskAssessment(dir, 1);
		expect(read?.verdictName).toBe("VERIFIED");
		expect(read?.configFingerprint).toBe("a".repeat(64));
	});

	it("refuses a record naming a different run than the path it was found at", async () => {
		const dir = await rptDir();
		await writeRiskAssessment(dir, record);
		await writeFile(riskPathOf(dir, 1), JSON.stringify({ ...record, runId: 2 }), "utf8");
		await expect(readRiskAssessment(dir, 1)).rejects.toBeInstanceOf(InvalidRiskRecordError);
	});

	it("refuses a score outside the range assessRisk can ever produce", async () => {
		const dir = await rptDir();
		await writeRiskAssessment(dir, record);
		await writeFile(riskPathOf(dir, 1), JSON.stringify({ ...record, score: 999 }), "utf8");
		await expect(readRiskAssessment(dir, 1)).rejects.toBeInstanceOf(InvalidRiskRecordError);
	});

	it("refuses a level rpt has never heard of", async () => {
		const dir = await rptDir();
		await writeRiskAssessment(dir, record);
		await writeFile(riskPathOf(dir, 1), JSON.stringify({ ...record, level: "SEVERE" }), "utf8");
		await expect(readRiskAssessment(dir, 1)).rejects.toBeInstanceOf(InvalidRiskRecordError);
	});

	it("refuses a file that is not valid json", async () => {
		const dir = await rptDir();
		await writeRiskAssessment(dir, record);
		await writeFile(riskPathOf(dir, 1), "{not json", "utf8");
		await expect(readRiskAssessment(dir, 1)).rejects.toBeInstanceOf(InvalidRiskRecordError);
	});
});
