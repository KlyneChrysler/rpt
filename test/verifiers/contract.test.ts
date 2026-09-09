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

	it("skips a verifier that returns skipped without a reason, keeping other results", async () => {
		const results = await runVerifiers(
			[
				verifier("bad", async () => ({ id: "bad", status: "skipped", reason: null, facts: {} })),
				verifier("ok", async () => ({ id: "ok", status: "passed", reason: null, facts: {} })),
			],
			context,
		);
		expect(results[0]?.status).toBe("skipped");
		expect(results[0]?.reason).toContain("reason");
		expect(results[1]?.status).toBe("passed");
	});

	it("skips a verifier that returns a blank reason, keeping other results", async () => {
		const results = await runVerifiers(
			[
				verifier("blank", async () => ({ id: "blank", status: "failed", reason: "   ", facts: {} })),
				verifier("ok", async () => ({ id: "ok", status: "passed", reason: null, facts: {} })),
			],
			context,
		);
		expect(results[0]?.status).toBe("skipped");
		expect(results[0]?.reason).toContain("reason");
		expect(results[1]?.status).toBe("passed");
	});

	it("converts a verifier that throws null into a skipped result", async () => {
		const [result] = await runVerifiers(
			[verifier("throwNull", async () => { throw null; })],
			context,
		);
		expect(result?.status).toBe("skipped");
		expect(result?.reason).toBeTruthy();
	});

	it("converts a verifier that throws a string into a skipped result carrying the string", async () => {
		const [result] = await runVerifiers(
			[verifier("throwString", async () => { throw "custom error text"; })],
			context,
		);
		expect(result?.status).toBe("skipped");
		expect(result?.reason).toContain("custom error text");
	});

	it("converts a verifier that rejects asynchronously into a skipped result", async () => {
		const results = await runVerifiers(
			[
				verifier("asyncReject", async () => Promise.reject(new Error("async failure"))),
				verifier("ok", async () => ({ id: "ok", status: "passed", reason: null, facts: {} })),
			],
			context,
		);
		expect(results[0]?.status).toBe("skipped");
		expect(results[0]?.reason).toContain("async failure");
		expect(results[1]?.status).toBe("passed");
	});

	it("passed() creates a passed result with default empty facts", async () => {
		const { passed } = await import("../../src/verifiers/Verifier.js");
		const result = passed("test-id");
		expect(result.id).toBe("test-id");
		expect(result.status).toBe("passed");
		expect(result.reason).toBe(null);
		expect(result.facts).toEqual({});
	});

	it("passed() accepts and includes custom facts", async () => {
		const { passed } = await import("../../src/verifiers/Verifier.js");
		const facts = { count: 42, name: "test" };
		const result = passed("test-id", facts);
		expect(result.facts).toEqual(facts);
	});

	it("failed() creates a failed result with required reason", async () => {
		const { failed } = await import("../../src/verifiers/Verifier.js");
		const result = failed("test-id", "something went wrong");
		expect(result.id).toBe("test-id");
		expect(result.status).toBe("failed");
		expect(result.reason).toBe("something went wrong");
		expect(result.facts).toEqual({});
	});

	it("failed() accepts and includes custom facts", async () => {
		const { failed } = await import("../../src/verifiers/Verifier.js");
		const facts = { code: "E_MISMATCH" };
		const result = failed("test-id", "mismatch", facts);
		expect(result.facts).toEqual(facts);
	});

	it("skipped() creates a skipped result with required reason", async () => {
		const { skipped } = await import("../../src/verifiers/Verifier.js");
		const result = skipped("test-id", "check not available");
		expect(result.id).toBe("test-id");
		expect(result.status).toBe("skipped");
		expect(result.reason).toBe("check not available");
		expect(result.facts).toEqual({});
	});
});
