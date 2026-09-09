import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { startFailuresOf } from "../../src/store/paths.js";
import { readStartFailures, recordStartFailure } from "../../src/store/startFailures.js";

let rptDir = "";

beforeEach(async () => {
	rptDir = await mkdtemp(join(tmpdir(), "rpt-failures-"));
});

describe("start failures", () => {
	it("is empty when nothing has ever failed to start", async () => {
		expect(await readStartFailures(rptDir)).toEqual([]);
	});

	it("creates the rpt directory and round trips a reason, newest last", async () => {
		await recordStartFailure(rptDir, "first");
		await recordStartFailure(rptDir, "second");
		expect((await readStartFailures(rptDir)).map((failure) => failure.reason)).toEqual(["first", "second"]);
	});

	it("timestamps each failure", async () => {
		await recordStartFailure(rptDir, "why");
		expect(Number.isNaN(Date.parse((await readStartFailures(rptDir))[0]!.ts))).toBe(false);
	});

	// This file exists to make a failure visible, so failing to read one of its own
	// lines must never become a second failure that hides the first: the readable
	// reasons still come back.
	it("drops a torn line and keeps the readable ones", async () => {
		await recordStartFailure(rptDir, "readable");
		await appendFile(startFailuresOf(rptDir), '{"ts":"2026-09-09T10:00:00.000Z","rea');
		await recordStartFailure(rptDir, "also readable");
		const reasons = (await readStartFailures(rptDir)).map((failure) => failure.reason);
		expect(reasons).toEqual(["readable", "also readable"]);
	});

	it("drops a line that parses but is not a failure", async () => {
		await appendFile(startFailuresOf(rptDir), '42\n{"ts":1,"reason":2}\n');
		expect(await readStartFailures(rptDir)).toEqual([]);
	});
});
