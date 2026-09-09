import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffNameStatus, diffStat } from "../../src/git/diff.js";
import { createSnapshot } from "../../src/git/snapshot.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

describe("diffNameStatus", () => {
	it("reports additions, modifications and deletions", async () => {
		const repo = await makeFixtureRepo();
		const base = await createSnapshot(repo, 1, "base");
		await writeFile(join(repo, "added.ts"), "export const a = 1;\n");
		await writeFile(join(repo, "README.md"), "changed\n");
		await rm(join(repo, "README.md"));
		await writeFile(join(repo, "README.md"), "changed\n");
		const end = await createSnapshot(repo, 1, "end");
		const entries = await diffNameStatus(repo, base, end);
		expect(entries).toEqual(
			expect.arrayContaining([
				{ path: "added.ts", status: "A" },
				{ path: "README.md", status: "M" },
			]),
		);
	});

	it("is empty when nothing changed", async () => {
		const repo = await makeFixtureRepo();
		const base = await createSnapshot(repo, 1, "base");
		const end = await createSnapshot(repo, 1, "end");
		expect(await diffNameStatus(repo, base, end)).toEqual([]);
	});
});

describe("diffStat", () => {
	it("counts added and removed lines", async () => {
		const repo = await makeFixtureRepo();
		const base = await createSnapshot(repo, 1, "base");
		await writeFile(join(repo, "added.ts"), "a\nb\nc\n");
		const end = await createSnapshot(repo, 1, "end");
		expect(await diffStat(repo, base, end)).toEqual({ added: 3, removed: 0 });
	});
});
