import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCurrentRunId, transitionCurrentRun } from "../../src/store/currentRun.js";

async function tempRptDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "rpt-current-"));
}

describe("currentRun pointer", () => {
	it("reads null when no run has ever started", async () => {
		const rptDir = await tempRptDir();
		expect(await readCurrentRunId(rptDir)).toBeNull();
	});

	it("reads back the value a transition wrote", async () => {
		const rptDir = await tempRptDir();
		await transitionCurrentRun(rptDir, async () => ({ next: 7, result: undefined }));
		expect(await readCurrentRunId(rptDir)).toBe(7);
	});

	it("clears the pointer when a transition writes null", async () => {
		const rptDir = await tempRptDir();
		await transitionCurrentRun(rptDir, async () => ({ next: 7, result: undefined }));
		await transitionCurrentRun(rptDir, async () => ({ next: null, result: undefined }));
		expect(await readCurrentRunId(rptDir)).toBeNull();
	});

	it("passes the current value into the transition and returns its result", async () => {
		const rptDir = await tempRptDir();
		await transitionCurrentRun(rptDir, async (current) => {
			expect(current).toBeNull();
			return { next: 3, result: undefined };
		});
		const seen = await transitionCurrentRun(rptDir, async (current) => ({ next: current, result: current }));
		expect(seen).toBe(3);
		expect(await readCurrentRunId(rptDir)).toBe(3);
	});

	// A corrupt or hand-edited pointer file (partial write, disk gremlin) must degrade
	// to "no run in progress" rather than crash the reader or be misread as a run id.
	it("treats a non-empty, non-numeric pointer value as no run in progress", async () => {
		const rptDir = await tempRptDir();
		await writeFile(join(rptDir, "current"), "not-a-run-id", "utf8");
		expect(await readCurrentRunId(rptDir)).toBeNull();
	});

	it("serializes concurrent transitions so neither ever reads the other's stale value", async () => {
		const rptDir = await tempRptDir();
		await transitionCurrentRun(rptDir, async () => ({ next: 1, result: undefined }));

		const seen: Array<number | null> = [];
		await Promise.all([
			transitionCurrentRun(rptDir, async (current) => {
				seen.push(current);
				return { next: null, result: undefined };
			}),
			transitionCurrentRun(rptDir, async (current) => {
				seen.push(current);
				return { next: null, result: undefined };
			}),
		]);
		// If the two transitions interleaved instead of serializing, both would see 1
		// (the value neither had written null over yet).
		expect(seen).toHaveLength(2);
		expect(seen).toContain(1);
		expect(seen).toContain(null);
	});
});
