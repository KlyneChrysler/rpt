import { describe, expect, it } from "vitest";
import { parseLcov } from "../../src/verifiers/lcov.js";

const body = ["SF:src/auth.ts", "DA:1,3", "DA:2,0", "DA:3,7", "end_of_record", "SF:src/db.ts", "DA:1,1", "end_of_record"].join("\n");

describe("parseLcov", () => {
	it("collects executed lines per file", () => {
		expect([...(parseLcov(body).get("src/auth.ts") ?? [])]).toEqual([1, 3]);
	});

	it("excludes lines with a zero hit count", () => {
		expect(parseLcov(body).get("src/auth.ts")?.has(2)).toBe(false);
	});

	it("handles multiple records", () => {
		expect(parseLcov(body).size).toBe(2);
	});

	it("returns an empty map for empty input", () => {
		expect(parseLcov("").size).toBe(0);
	});
});
