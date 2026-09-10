import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRunConfig } from "../../src/app/loadRunConfig.js";
import { DEFAULT_CONFIG } from "../../src/config/load.js";
import { rptDirOf } from "../../src/store/paths.js";
import { writeRunConfig } from "../../src/store/runConfig.js";

describe("loadRunConfig", () => {
	it("reads the run's own snapshot when one exists, even if the live repo config differs", async () => {
		const repo = await mkdtemp(join(tmpdir(), "rpt-loadrunconfig-"));
		const snapshot = { ...DEFAULT_CONFIG, testCommand: "snapshot command" };
		await writeRunConfig(rptDirOf(repo), 1, snapshot);
		await writeFile(join(repo, "rpt.config.json"), JSON.stringify({ testCommand: "live command" }));
		const config = await loadRunConfig(repo, 1);
		expect(config.testCommand).toBe("snapshot command");
	});

	it("falls back to a live read for a run that predates snapshotting", async () => {
		const repo = await mkdtemp(join(tmpdir(), "rpt-loadrunconfig-"));
		await writeFile(join(repo, "rpt.config.json"), JSON.stringify({ testCommand: "live command" }));
		const config = await loadRunConfig(repo, 1);
		expect(config.testCommand).toBe("live command");
	});
});
