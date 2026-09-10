import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/load.js";
import { runConfigPathOf } from "../../src/store/paths.js";
import { readRunConfig, writeRunConfig } from "../../src/store/runConfig.js";

let rptDir = "";

beforeEach(async () => {
	rptDir = await mkdtemp(join(tmpdir(), "rpt-runconfig-"));
});

describe("writeRunConfig / readRunConfig", () => {
	it("round-trips a written snapshot, creating the run directory itself", async () => {
		await writeRunConfig(rptDir, 1, DEFAULT_CONFIG);
		expect(await readRunConfig(rptDir, 1)).toEqual(DEFAULT_CONFIG);
	});

	it("returns null when no snapshot has been written", async () => {
		expect(await readRunConfig(rptDir, 1)).toBeNull();
	});

	it("rejects a snapshot that fails the config schema", async () => {
		await writeRunConfig(rptDir, 1, DEFAULT_CONFIG);
		await writeFile(runConfigPathOf(rptDir, 1), JSON.stringify({ thresholds: { review: -1, approval: 51, block: 81 } }), "utf8");
		await expect(readRunConfig(rptDir, 1)).rejects.toThrow();
	});

	it("rejects unparseable JSON", async () => {
		await writeRunConfig(rptDir, 1, DEFAULT_CONFIG);
		await writeFile(runConfigPathOf(rptDir, 1), "{not json", "utf8");
		await expect(readRunConfig(rptDir, 1)).rejects.toThrow(/JSON/);
	});
});
