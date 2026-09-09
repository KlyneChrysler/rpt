import { describe, expect, it } from "vitest";
import {
	IllegalTransitionError,
	isTerminal,
	requiresHumanDecision,
	transition,
	type RunState,
} from "../../src/domain/state.js";

const legal: [RunState, RunState][] = [
	["RUNNING", "ENDED"],
	["ENDED", "VERIFYING"],
	["VERIFYING", "VERIFIED"],
	["VERIFYING", "FAILED"],
	["VERIFYING", "UNVERIFIED"],
	["VERIFIED", "AWAITING_APPROVAL"],
	["FAILED", "AWAITING_APPROVAL"],
	["UNVERIFIED", "AWAITING_APPROVAL"],
	["AWAITING_APPROVAL", "APPROVED"],
	["AWAITING_APPROVAL", "REJECTED"],
	["APPROVED", "RECORDED"],
	["VERIFIED", "RECORDED"],
];

const illegal: [RunState, RunState][] = [
	["RUNNING", "VERIFIED"],
	["ENDED", "APPROVED"],
	["REJECTED", "APPROVED"],
	["RECORDED", "RUNNING"],
	["FAILED", "RECORDED"],
];

describe("transition", () => {
	it.each(legal)("allows %s -> %s", (from, to) => {
		expect(transition(from, to)).toBe(to);
	});

	it.each(illegal)("rejects %s -> %s", (from, to) => {
		expect(() => transition(from, to)).toThrow(IllegalTransitionError);
	});

	it("names both states in the error message", () => {
		expect(() => transition("RUNNING", "VERIFIED")).toThrow(/RUNNING.*VERIFIED/);
	});
});

describe("classification", () => {
	it("treats RECORDED and REJECTED as terminal", () => {
		expect(isTerminal("RECORDED")).toBe(true);
		expect(isTerminal("REJECTED")).toBe(true);
		expect(isTerminal("VERIFIED")).toBe(false);
	});

	it("requires a human for failed and unverified runs regardless of score", () => {
		expect(requiresHumanDecision("FAILED")).toBe(true);
		expect(requiresHumanDecision("UNVERIFIED")).toBe(true);
		expect(requiresHumanDecision("VERIFIED")).toBe(false);
	});
});
