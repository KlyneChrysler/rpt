import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffNameStatus, diffStat } from "../../src/git/diff.js";
import { createSnapshot } from "../../src/git/snapshot.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

describe("diffNameStatus", () => {
	it("reports additions and modifications", async () => {
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

	it("reports deletions", async () => {
		const repo = await makeFixtureRepo();
		await writeFile(join(repo, "gone.ts"), "temporary\n");
		const base = await createSnapshot(repo, 1, "base");
		await rm(join(repo, "gone.ts"));
		const end = await createSnapshot(repo, 1, "end");
		const entries = await diffNameStatus(repo, base, end);
		expect(entries).toEqual(expect.arrayContaining([{ path: "gone.ts", status: "D" }]));
	});

	it("reports renames under the new path, with the old path carried alongside", async () => {
		const repo = await makeFixtureRepo();
		const body = Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i};`).join("\n");
		await writeFile(join(repo, "old.ts"), body);
		const base = await createSnapshot(repo, 1, "base");
		await rm(join(repo, "old.ts"));
		await writeFile(join(repo, "renamed.ts"), body);
		const end = await createSnapshot(repo, 1, "end");
		const entries = await diffNameStatus(repo, base, end);
		expect(entries).toEqual(
			expect.arrayContaining([{ path: "renamed.ts", status: "R", oldPath: "old.ts" }]),
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

	it("counts removed lines", async () => {
		const repo = await makeFixtureRepo();
		await writeFile(join(repo, "gone.ts"), "a\nb\nc\n");
		const base = await createSnapshot(repo, 1, "base");
		await rm(join(repo, "gone.ts"));
		const end = await createSnapshot(repo, 1, "end");
		expect(await diffStat(repo, base, end)).toEqual({ added: 0, removed: 3 });
	});

	// git's own rename detection is on by default for `git diff`, with or
	// without -M, so a plain rename's numstat record shows up under -z as a
	// numeric field with an empty third (path) slot, followed by the old and
	// new path as two further NUL fields - neither of them numeric. A reducer
	// that treats every NUL field as its own "added\tremoved\tpath" record
	// feeds those bare filenames to Number() and corrupts the total to NaN.
	// Asserting the exact number, not just its type, is the point: a reducer
	// that silently returns NaN would still satisfy `toBeTypeOf("number")`.
	it("counts zero lines for a pure rename with no content change", async () => {
		const repo = await makeFixtureRepo();
		const body = Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i};`).join("\n");
		await writeFile(join(repo, "old.ts"), body);
		const base = await createSnapshot(repo, 1, "base");
		await rm(join(repo, "old.ts"));
		await writeFile(join(repo, "renamed.ts"), body);
		const end = await createSnapshot(repo, 1, "end");
		expect(await diffStat(repo, base, end)).toEqual({ added: 0, removed: 0 });
	});

	it("counts exact totals across a diff mixing a rename with an addition and a modification", async () => {
		const repo = await makeFixtureRepo();
		const body = Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i};`).join("\n");
		await writeFile(join(repo, "old.ts"), body);
		await writeFile(join(repo, "keep.ts"), "a\nb\nc\n");
		const base = await createSnapshot(repo, 1, "base");

		await rm(join(repo, "old.ts"));
		await writeFile(join(repo, "renamed.ts"), body); // pure rename: +0/-0
		await writeFile(join(repo, "keep.ts"), "a\nZ\nc\n"); // modification: +1/-1
		await writeFile(join(repo, "added.ts"), "x\ny\n"); // addition: +2/-0

		const end = await createSnapshot(repo, 1, "end");
		expect(await diffStat(repo, base, end)).toEqual({ added: 3, removed: 1 });
	});
});
