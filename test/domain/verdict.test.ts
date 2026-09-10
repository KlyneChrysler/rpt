import { describe, expect, it } from "vitest";
import { decideVerdict } from "../../src/domain/verdict.js";
import type { VerifierResult } from "../../src/verifiers/Verifier.js";

function result(id: string, status: VerifierResult["status"]): VerifierResult {
	return { id, status, reason: status === "passed" ? null : "because", facts: {} };
}

describe("decideVerdict", () => {
	it("is VERIFIED when every verifier passed and there are no gaps", () => {
		expect(decideVerdict([result("a", "passed"), result("b", "passed")], false)).toBe("VERIFIED");
	});

	it("is FAILED when any verifier failed", () => {
		expect(decideVerdict([result("a", "passed"), result("b", "failed")], false)).toBe("FAILED");
	});

	it("prefers FAILED over UNVERIFIED when both a failure and a skip are present", () => {
		expect(decideVerdict([result("a", "failed"), result("b", "skipped")], false)).toBe("FAILED");
	});

	it("is UNVERIFIED when a verifier was skipped", () => {
		expect(decideVerdict([result("a", "passed"), result("b", "skipped")], false)).toBe("UNVERIFIED");
	});

	it("is UNVERIFIED when the log has gaps even though everything passed", () => {
		expect(decideVerdict([result("a", "passed")], true)).toBe("UNVERIFIED");
	});

	it("is UNVERIFIED when no verifier ran at all", () => {
		expect(decideVerdict([], false)).toBe("UNVERIFIED");
	});
});
