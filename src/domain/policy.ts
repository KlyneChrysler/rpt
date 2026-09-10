import type { VerdictName } from "./verdict.js";

// The four risk levels exist at runtime, not just in the type system, for the
// same reason RUN_STATES does (see ./state.ts): src/risk/assess.ts needs a
// value it can compute and compare, not just a compile-time label, and
// src/risk's purity rule allows it to import this type-only from here. Domain
// owns the one declaration; risk consumes it. A second, independently
// maintained copy in src/risk (what used to live here, redeclared instead of
// imported to satisfy the domain purity guard) is exactly the drift this
// avoids - two names for the same four strings with nothing binding them.
export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export type Decision = "auto" | "review" | "approval" | "block";

// CRITICAL is checked first so no verdict can unlock it. A blocked run has no
// approval path by design; the change must be reduced, not signed off.
export function decide(verdict: VerdictName, level: RiskLevel): Decision {
	if (level === "CRITICAL") return "block";
	if (verdict !== "VERIFIED") return "approval";
	if (level === "HIGH") return "approval";
	return level === "MEDIUM" ? "review" : "auto";
}
