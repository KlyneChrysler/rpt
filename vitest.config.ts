import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		coverage: {
			provider: "v8",
			thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
			exclude: ["dist/**", "test/**", "*.config.ts"],
		},
	},
});
