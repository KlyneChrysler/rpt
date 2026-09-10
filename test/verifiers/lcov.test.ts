import { describe, expect, it } from "vitest";
import { parseLcov, parseLcovRecordedLines } from "../../src/verifiers/lcov.js";

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

describe("parseLcovRecordedLines", () => {
	// DA:2,0 is a line the coverage tool measured and found zero executions of -
	// still a recorded line, distinct from a line with no DA entry at all (a
	// blank line, an import, a type-only line) that the tool never instrumented.
	it("includes a line recorded with a zero hit count", () => {
		expect(parseLcovRecordedLines(body).get("src/auth.ts")?.has(2)).toBe(true);
	});

	it("collects every recorded line per file, hit or not", () => {
		expect([...(parseLcovRecordedLines(body).get("src/auth.ts") ?? [])]).toEqual([1, 2, 3]);
	});

	it("does not record a line for a file with no SF: record at all", () => {
		expect(parseLcovRecordedLines(body).get("src/nowhere.ts")).toBeUndefined();
	});

	it("still marks a file present, with no recorded lines, when its SF: record has no DA: lines", () => {
		const empty = ["SF:src/empty.ts", "end_of_record"].join("\n");
		expect(parseLcovRecordedLines(empty).get("src/empty.ts")).toEqual(new Set());
	});

	it("returns an empty map for empty input", () => {
		expect(parseLcovRecordedLines("").size).toBe(0);
	});
});
