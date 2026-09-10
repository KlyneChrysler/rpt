import type { RptConfig } from "../config/schema.js";
import type { RiskLevel } from "../domain/policy.js";
import type { RunFacts } from "./facts.js";
import { DEFAULT_RULES, type RiskRule } from "./rules.js";

// Re-exported so existing and future callers can still pull RiskLevel from
// this module by name - domain/policy.ts is the one place that declares it
// now (see the comment there); this is just a value-free re-export, not a
// second declaration.
export type { RiskLevel };

export type Contribution = { id: string; label: string; points: number };

export type RiskAssessment = { score: number; level: RiskLevel; contributions: Contribution[] };

export function assessRisk(facts: RunFacts, config: RptConfig): RiskAssessment {
	assertOverridesKnown(config);
	const contributions = DEFAULT_RULES.filter((rule) => rule.when(facts)).map((rule) => contributionOf(rule, facts, config));
	const score = clamp(contributions.reduce((total, entry) => total + entry.points, 0));
	return { score, level: levelOf(score, config), contributions };
}

function contributionOf(rule: RiskRule, facts: RunFacts, config: RptConfig): Contribution {
	const baseline = typeof rule.points === "function" ? rule.points(facts) : rule.points;
	const override = config.ruleOverrides[rule.id];
	return { id: rule.id, label: rule.label, points: override === undefined ? baseline : flooredOverride(baseline, override) };
}

// A positive baseline is the rule's own finding that the change is risky in
// some specific way (a sensitive path touched, a dependency changed, ...).
// An override may raise that - a project deciding a category matters more
// than the default - but never lower it: zeroing out (or otherwise
// weakening) a positive rule's override is the same "empty the sensitive-
// path map" attack in a different field, at the same cost, against the
// shipped build. A credit rule's baseline (tests-added, scan-clean, ...) is
// zero or negative and is unaffected - only config/schema.ts's floor of zero
// bounds those, unchanged from before.
function flooredOverride(baseline: number, override: number): number {
	return baseline > 0 ? Math.max(override, baseline) : override;
}

function assertOverridesKnown(config: RptConfig): void {
	const known = new Set(DEFAULT_RULES.map((rule) => rule.id));
	const unknown = Object.keys(config.ruleOverrides).filter((id) => !known.has(id));
	if (unknown.length > 0) throw new Error(`unknown risk rule override(s): ${unknown.join(", ")}`);
}

function levelOf(score: number, config: RptConfig): RiskLevel {
	if (score >= config.thresholds.block) return "CRITICAL";
	if (score >= config.thresholds.approval) return "HIGH";
	if (score >= config.thresholds.review) return "MEDIUM";
	return "LOW";
}

function clamp(score: number): number {
	return Math.min(100, Math.max(0, score));
}
