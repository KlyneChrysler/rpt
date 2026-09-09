import { z } from "zod";

export const thresholdsSchema = z
	.object({ review: z.number().int(), approval: z.number().int(), block: z.number().int() })
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
		ruleOverrides: z.record(z.string(), z.number()).default({}),
		verifiers: z
			.object({ testQuality: z.enum(["require", "warn", "off"]).default("warn") })
			.strict()
			.default({ testQuality: "warn" }),
	})
	.strict();

export type RptConfig = z.infer<typeof configSchema>;
