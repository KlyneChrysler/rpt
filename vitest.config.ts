import { defineConfig } from "vitest/config";

export default defineConfig({
	// The Ink surface is written in TSX and its tests render real components,
	// so both the source transform and the test glob have to know about JSX.
	esbuild: { jsx: "automatic" },
	test: {
		include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
		// Every suite that drives a hook would otherwise spawn a real, detached
		// collector daemon that outlives the run. One test deliberately turns
		// this back off to exercise the auto-start path for real.
		setupFiles: ["test/support/setup.ts"],
		// Most of this suite is integration work: it creates git repositories,
		// takes snapshots, opens detached worktrees and runs test commands in
		// them. Five seconds is a unit-test default and it made several of those
		// suites flaky on the slowest CI runner rather than failing honestly.
		testTimeout: 30_000,
		hookTimeout: 120_000,
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
