import type { RiskLevel } from "../domain/policy.js";

// One place decides what a band and a state look like. A screen picking its
// own colours is how HIGH comes to be yellow on one screen and red on the
// next, which turns the single most important signal in the tool into
// decoration.
export function colorForLevel(level: RiskLevel | null): string {
	if (level === "CRITICAL") return "red";
	if (level === "HIGH") return "yellow";
	if (level === "MEDIUM") return "cyan";
	return level === "LOW" ? "green" : "gray";
}

export function colorForState(state: string): string {
	if (state === "VERIFIED" || state === "APPROVED" || state === "RECORDED") return "green";
	if (state === "FAILED" || state === "REJECTED") return "red";
	if (state === "UNVERIFIED" || state === "AWAITING_APPROVAL") return "yellow";
	return "cyan";
}
