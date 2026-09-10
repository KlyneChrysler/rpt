import { defineConfig } from "vitest/config";

export default defineConfig({
	// The Ink surface is written in TSX and its tests render real components,
	// so both the source transform and the test glob have to know about JSX.
	esbuild: { jsx: "automatic" },
	test: {
		include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
		coverage: {
			provider: "v8",
			// v8's default reporter set ("text", "html", "clover", "json") never
			// includes lcov, so "pnpm test:cov" produced no coverage/lcov.info -
			// the exact file TestQualityVerifier reads. Without "lcov" here,
			// configuring rpt to verify this repository's own runs always skips.
			reporter: ["text", "lcov"],
			thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
			exclude: ["dist/**", "test/**", "*.config.ts"],
		},
	},
});
