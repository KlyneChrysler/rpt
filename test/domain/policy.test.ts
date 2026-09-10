import { describe, expect, it } from "vitest";
import { decide } from "../../src/domain/policy.js";

describe("decide", () => {
	it("clears a verified low risk run automatically", () => {
		expect(decide("VERIFIED", "LOW")).toBe("auto");
	});

	it("recommends review for a verified medium risk run without blocking", () => {
		expect(decide("VERIFIED", "MEDIUM")).toBe("review");
	});

	it("requires approval for a verified high risk run", () => {
		expect(decide("VERIFIED", "HIGH")).toBe("approval");
	});

	it("blocks a critical run outright, with no approval path", () => {
		expect(decide("VERIFIED", "CRITICAL")).toBe("block");
	});

	it("requires approval for a failed run even at low risk", () => {
		expect(decide("FAILED", "LOW")).toBe("approval");
	});

	it("requires approval for an unverified run even at low risk", () => {
		expect(decide("UNVERIFIED", "LOW")).toBe("approval");
	});

	it("still blocks a failed critical run rather than offering approval", () => {
		expect(decide("FAILED", "CRITICAL")).toBe("block");
	});
});
