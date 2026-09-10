import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Verdict } from "../../src/domain/verdict.js";
import { runDirOf, verdictPathOf } from "../../src/store/paths.js";
import { readVerdict, writeVerdict } from "../../src/store/verdicts.js";

let rptDir = "";

function verdict(overrides: Partial<Verdict> = {}): Verdict {
	return {
		runId: 1,
		name: "VERIFIED",
		results: [{ id: "tests", status: "passed", reason: null, facts: {} }],
		decidedAt: "2026-09-10T10:00:00.000Z",
		...overrides,
	};
}

beforeEach(async () => {
	rptDir = await mkdtemp(join(tmpdir(), "rpt-verdicts-"));
	await mkdir(runDirOf(rptDir, 1), { recursive: true });
});

describe("writeVerdict / readVerdict", () => {
	it("round-trips a written verdict", async () => {
		await writeVerdict(rptDir, verdict());
		expect(await readVerdict(rptDir, 1)).toEqual(verdict());
	});

	it("returns null when nothing has been recorded", async () => {
		expect(await readVerdict(rptDir, 2)).toBeNull();
	});
});

describe("readVerdict validation", () => {
	async function writeRaw(runId: number, raw: unknown): Promise<void> {
		await mkdir(runDirOf(rptDir, runId), { recursive: true });
		await writeFile(verdictPathOf(rptDir, runId), JSON.stringify(raw), "utf8");
	}

	// The exploit this closes: a one-line edit naming a different run turned a
	// refused critical approval into a recorded one, because the verdict was
	// trusted as this run's own just because it was found at this run's path.
	it("rejects a record whose runId does not match the run being read", async () => {
		await writeRaw(1, verdict({ runId: 2 }));
		await expect(readVerdict(rptDir, 1)).rejects.toThrow(/run 1/);
	});

	it("rejects a verdict name outside the known enum", async () => {
		await writeRaw(1, { ...verdict(), name: "PASSED" });
		await expect(readVerdict(rptDir, 1)).rejects.toThrow();
	});

	it("rejects a verifier result status outside the known enum", async () => {
		await writeRaw(1, verdict({ results: [{ id: "tests", status: "maybe", reason: null, facts: {} }] }));
		await expect(readVerdict(rptDir, 1)).rejects.toThrow();
	});

	it("rejects a decidedAt that is not a real timestamp", async () => {
		await writeRaw(1, { ...verdict(), decidedAt: "klyne\nFORGED" });
		await expect(readVerdict(rptDir, 1)).rejects.toThrow();
	});

	it("rejects unparseable JSON", async () => {
		await writeFile(verdictPathOf(rptDir, 1), "{not json", "utf8");
		await expect(readVerdict(rptDir, 1)).rejects.toThrow(/JSON/);
	});

	it("rejects an unknown extra field rather than silently ignoring it", async () => {
		await writeRaw(1, { ...verdict(), forged: true });
		await expect(readVerdict(rptDir, 1)).rejects.toThrow();
	});
});
