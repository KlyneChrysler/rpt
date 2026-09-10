import { z } from "zod";

// Bounded to the same [0, 100] range assessRisk's score is clamped to
// (src/risk/assess.ts). Nothing forces rpt.config.json to be written by
// anyone who isn't the agent whose own run it is about, so an unbounded
// "block" threshold needs no forgery at all to defeat: raise it past
// whatever a score can ever reach and CRITICAL becomes unreachable, self-
// clearing the very run that raised it, since loadConfig always reads
// whatever rpt.config.json says right now.
const RISK_SCORE_MIN = 0;
const RISK_SCORE_MAX = 100;
const boundedThreshold = z.number().int().min(RISK_SCORE_MIN).max(RISK_SCORE_MAX);

export const thresholdsSchema = z
	.object({ review: boundedThreshold, approval: boundedThreshold, block: boundedThreshold })
	.refine(
		(t) => t.review < t.approval && t.approval < t.block,
		{ message: "thresholds must be ascending: review < approval < block" },
	);

export const configSchema = z
	.object({
		testCommand: z.string().nullable().default(null),
		coverageCommand: z.string().nullable().default(null),
		sensitivePaths: z.record(z.string(), z.array(z.string())).default({
			auth: ["**/auth/**", "**/*auth*.*", "**/session/**"],
			database: ["**/db/**", "**/migrations/**", "**/*repository*.*"],
			infra: ["infra/**", "Dockerfile*", ".github/workflows/**", "**/*.tf"],
		}),
		thresholds: thresholdsSchema.default({ review: 21, approval: 51, block: 81 }),
		// Floored at zero: a negative override lets a config edit cancel out a
		// rule's real points (or, stacked, push the total below what the rule's
		// own risky finding should ever allow) rather than merely re-weighting
		// it. A rule whose own baseline is legitimately a credit (tests-added,
		// scan-clean, ...) keeps that credit; only overriding it to something
		// more negative than zero is what this closes.
		ruleOverrides: z.record(z.string(), z.number().min(0)).default({}),
		verifiers: z
			.object({ testQuality: z.enum(["require", "warn", "off"]).default("warn") })
			.strict()
			.default({ testQuality: "warn" }),
	})
	.strict();

export type RptConfig = z.infer<typeof configSchema>;
