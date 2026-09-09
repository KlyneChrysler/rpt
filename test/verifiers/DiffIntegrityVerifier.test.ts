import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/load.js";
import { createSnapshot } from "../../src/git/snapshot.js";
import { diffIntegrityVerifier } from "../../src/verifiers/DiffIntegrityVerifier.js";
import type { RunContext } from "../../src/verifiers/Verifier.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

async function contextAfter(
	writes: Record<string, string>,
	claimed: string[],
): Promise<RunContext> {
	const repo = await makeFixtureRepo();
	const baseSha = await createSnapshot(repo, 1, "base");
	for (const [path, body] of Object.entries(writes)) await writeFile(join(repo, path), body);
	const endSha = await createSnapshot(repo, 1, "end");
	return {
		repoRoot: repo,
		worktree: repo,
		baseSha,
		endSha,
		config: DEFAULT_CONFIG,
		claims: { mutatedPaths: claimed, commands: [] },
	};
}

describe("diffIntegrityVerifier", () => {
	it("passes when claims and observations agree", async () => {
		const result = await diffIntegrityVerifier.run(await contextAfter({ "a.ts": "1\n" }, ["a.ts"]));
		expect(result.status).toBe("passed");
	});

	it("fails and names files the agent never declared", async () => {
		const result = await diffIntegrityVerifier.run(
			await contextAfter({ "a.ts": "1\n", ".env.local": "SECRET=1\n" }, ["a.ts"]),
		);
		expect(result.status).toBe("failed");
		expect(result.facts.undeclared).toEqual([".env.local"]);
	});

	it("tolerates a claim for a file that ended up unchanged", async () => {
		const result = await diffIntegrityVerifier.run(await contextAfter({ "a.ts": "1\n" }, ["a.ts", "b.ts"]));
		expect(result.status).toBe("passed");
	});

	it("flags a manifest change separately from failing", async () => {
		const result = await diffIntegrityVerifier.run(
			await contextAfter({ "package-lock.json": "{}\n" }, ["package-lock.json"]),
		);
		expect(result.facts.manifestChanged).toBe(true);
		expect(result.status).toBe("passed");
	});

	it("counts added and removed lines", async () => {
		const result = await diffIntegrityVerifier.run(await contextAfter({ "a.ts": "1\n2\n3\n" }, ["a.ts"]));
		expect(result.facts.added).toBe(3);
	});

	it("passes on an empty diff with an empty claim", async () => {
		const result = await diffIntegrityVerifier.run(await contextAfter({}, []));
		expect(result.status).toBe("passed");
		expect(result.facts.observedPaths).toEqual([]);
	});

	// Plan 1's finding: git reports a rename under its new path only, so the old
	// path disappears from the observed set entirely. We deliberately carry both
	// sides of a rename into observedPaths - see DiffIntegrityVerifier.ts for the
	// reasoning. This is the scenario that motivates it: an agent could declare
	// only the destination name, silently walking a file away from a path it
	// never claimed at all (imagine renaming a secret into an innocuous name).
	// Enough unique content that git's similarity index detects a rename rather
	// than reporting an add plus a delete.
	it("catches an undeclared origin path when a rename is detected", async () => {
		const repo = await makeFixtureRepo();
		const body = Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i};`).join("\n");
		await writeFile(join(repo, "old.ts"), body);
		const baseSha = await createSnapshot(repo, 1, "base");
		await rm(join(repo, "old.ts"));
		await writeFile(join(repo, "new.ts"), body);
		const endSha = await createSnapshot(repo, 1, "end");
		const context: RunContext = {
			repoRoot: repo,
			worktree: repo,
			baseSha,
			endSha,
			config: DEFAULT_CONFIG,
			claims: { mutatedPaths: ["new.ts"], commands: [] },
		};

		const result = await diffIntegrityVerifier.run(context);

		expect(result.status).toBe("failed");
		expect(result.facts.observedPaths).toEqual(expect.arrayContaining(["old.ts", "new.ts"]));
		expect(result.facts.undeclared).toEqual(["old.ts"]);
	});

	it("passes a detected rename when the agent declares both the origin and destination", async () => {
		const repo = await makeFixtureRepo();
		const body = Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i};`).join("\n");
		await writeFile(join(repo, "old.ts"), body);
		const baseSha = await createSnapshot(repo, 1, "base");
		await rm(join(repo, "old.ts"));
		await writeFile(join(repo, "new.ts"), body);
		const endSha = await createSnapshot(repo, 1, "end");
		const context: RunContext = {
			repoRoot: repo,
			worktree: repo,
			baseSha,
			endSha,
			config: DEFAULT_CONFIG,
			claims: { mutatedPaths: ["old.ts", "new.ts"], commands: [] },
		};

		const result = await diffIntegrityVerifier.run(context);

		expect(result.status).toBe("passed");
	});
});
