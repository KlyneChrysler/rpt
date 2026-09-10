import type { VerdictName } from "./verdict.js";

// Redeclared rather than imported from ../risk/assess.js: src/domain must not
// import outside itself (see test/domain/purity.test.ts), even a type-only
// risk import, so risk stays a consumer of domain and never the reverse. The
// two declarations are structurally identical string-literal unions, so a
// RiskLevel produced by the risk engine still type-checks here unchanged.
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type Decision = "auto" | "review" | "approval" | "block";

// CRITICAL is checked first so no verdict can unlock it. A blocked run has no
// approval path by design; the change must be reduced, not signed off.
export function decide(verdict: VerdictName, level: RiskLevel): Decision {
	if (level === "CRITICAL") return "block";
	if (verdict !== "VERIFIED") return "approval";
	if (level === "HIGH") return "approval";
	return level === "MEDIUM" ? "review" : "auto";
}
