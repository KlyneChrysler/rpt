import { describe, expect, it } from "vitest";
import { runVerifiers, type RunContext, type Verifier } from "../../src/verifiers/Verifier.js";
import { DEFAULT_CONFIG } from "../../src/config/load.js";

const context: RunContext = {
	repoRoot: "/repo",
	worktree: "/wt",
	baseSha: "a".repeat(40),
	endSha: "b".repeat(40),
	config: DEFAULT_CONFIG,
	claims: { mutatedPaths: [], commands: [] },
};

function verifier(id: string, run: Verifier["run"]): Verifier {
	return { id, run };
}

describe("runVerifiers", () => {
	it("returns one result per verifier, in order", async () => {
		const results = await runVerifiers(
			[
				verifier("a", async () => ({ id: "a", status: "passed", reason: null, facts: {} })),
				verifier("b", async () => ({ id: "b", status: "failed", reason: "nope", facts: {} })),
			],
			context,
		);
		expect(results.map((result) => result.id)).toEqual(["a", "b"]);
	});

	it("converts a thrown verifier into a skipped result carrying the message", async () => {
		const [result] = await runVerifiers(
			[verifier("boom", async () => { throw new Error("git exploded"); })],
			context,
		);
		expect(result?.status).toBe("skipped");
		expect(result?.reason).toContain("git exploded");
	});

	it("keeps running the remaining verifiers after one throws", async () => {
		const results = await runVerifiers(
			[
				verifier("boom", async () => { throw new Error("x"); }),
				verifier("ok", async () => ({ id: "ok", status: "passed", reason: null, facts: {} })),
			],
			context,
		);
		expect(results[1]?.status).toBe("passed");
	});

	it("rejects a verifier that returns skipped without a reason", async () => {
		await expect(
			runVerifiers([verifier("bad", async () => ({ id: "bad", status: "skipped", reason: null, facts: {} }))], context),
		).rejects.toThrow(/reason/i);
	});
});
