import { describe, expect, it } from "vitest";
import { parseHunkHeader } from "../../src/git/hunkHeader.js";

describe("parseHunkHeader", () => {
	it("reads the new-file start and count", () => {
		expect(parseHunkHeader("@@ -11,3 +11,4 @@")).toEqual({ newStart: 11, newCount: 4 });
	});

	it("defaults the count to 1 when the header omits it", () => {
		expect(parseHunkHeader("@@ -1 +1 @@")).toEqual({ newStart: 1, newCount: 1 });
	});

	it("returns null for a line that is not a hunk header", () => {
		expect(parseHunkHeader("+++ b/auth.ts")).toBeNull();
	});

	it("reads a zero-length range for a pure deletion", () => {
		expect(parseHunkHeader("@@ -1,5 +0,0 @@")).toEqual({ newStart: 0, newCount: 0 });
	});
});
