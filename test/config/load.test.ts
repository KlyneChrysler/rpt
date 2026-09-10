import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";

async function repoWith(config?: unknown): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "rpt-config-"));
	if (config !== undefined) {
		await writeFile(join(dir, "rpt.config.json"), JSON.stringify(config));
	}
	return dir;
}

describe("loadConfig", () => {
	it("returns defaults when no config file exists", async () => {
		const config = await loadConfig(await repoWith());
		expect(config.thresholds).toEqual({ review: 21, approval: 51, block: 81 });
		expect(config.testCommand).toBeNull();
	});

	it("merges user values over defaults", async () => {
		const config = await loadConfig(await repoWith({ testCommand: "pnpm test" }));
		expect(config.testCommand).toBe("pnpm test");
		expect(config.thresholds.approval).toBe(51);
	});

	it("rejects unknown keys instead of ignoring them", async () => {
		await expect(loadConfig(await repoWith({ tsetCommand: "pnpm test" }))).rejects.toThrow(
			/unknown key/i,
		);
	});

	it("rejects thresholds that are out of order", async () => {
		const bad = { thresholds: { review: 60, approval: 51, block: 81 } };
		await expect(loadConfig(await repoWith(bad))).rejects.toThrow(/ascending/i);
	});

	// A run can edit rpt.config.json as freely as any other file in the repo,
	// and loadConfig always reads whatever it says right now - so raising
	// "block" past what a score can ever reach would self-clear the very run
	// that raised it. Capping thresholds to the same [0, 100] range a score is
	// clamped to closes that off without needing anyone to have forged anything.
	it("rejects a block threshold above the score range", async () => {
		const bad = { thresholds: { review: 21, approval: 51, block: 101 } };
		await expect(loadConfig(await repoWith(bad))).rejects.toThrow();
	});

	it("rejects a negative threshold", async () => {
		const bad = { thresholds: { review: -1, approval: 51, block: 81 } };
		await expect(loadConfig(await repoWith(bad))).rejects.toThrow();
	});

	it("rejects a rule override below zero", async () => {
		const bad = { ruleOverrides: { "dependency-changed": -20 } };
		await expect(loadConfig(await repoWith(bad))).rejects.toThrow();
	});

	it("accepts a rule override of exactly zero", async () => {
		const config = await loadConfig(await repoWith({ ruleOverrides: { "dependency-changed": 0 } }));
		expect(config.ruleOverrides["dependency-changed"]).toBe(0);
	});
});
