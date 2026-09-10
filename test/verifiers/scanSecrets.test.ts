import { describe, expect, it } from "vitest";
import { scanSecrets } from "../../src/verifiers/scanSecrets.js";

function patch(...addedLines: string[]): string {
	return ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", ...addedLines.map((line) => `+${line}`)].join("\n");
}

describe("scanSecrets", () => {
	it("finds a private key header", () => {
		const findings = scanSecrets(patch("-----BEGIN RSA PRIVATE KEY-----"));
		expect(findings[0]?.rule).toBe("private-key");
	});

	it("finds an assignment of a long high-entropy string to a secret-looking name", () => {
		const findings = scanSecrets(patch('const apiSecret = "Zq7Xk29fLp03Ta6BvNc81WdYh4Rj5MgS";'));
		expect(findings[0]?.rule).toBe("high-entropy-assignment");
	});

	it("ignores a low-entropy assignment even to a secret-looking name", () => {
		expect(scanSecrets(patch('const apiSecret = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";'))).toEqual([]);
	});

	it("ignores an obvious placeholder", () => {
		expect(scanSecrets(patch('const apiSecret = "your-api-key-here";'))).toEqual([]);
	});

	it("ignores removed lines", () => {
		const removal = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "-----BEGIN RSA PRIVATE KEY-----"].join("\n");
		expect(scanSecrets(removal)).toEqual([]);
	});

	it("reports the file the finding came from", () => {
		expect(scanSecrets(patch("-----BEGIN RSA PRIVATE KEY-----"))[0]?.path).toBe("x.ts");
	});

	it("finds nothing in an ordinary code change", () => {
		expect(scanSecrets(patch("export const timeout = AUTHENTICATION_TIMEOUT_MS;"))).toEqual([]);
	});

	it("tracks the real new-file line number across multiple hunks, not an ordinal count of added lines", () => {
		// Hunk 1 touches lines 1-3 and adds one line without introducing a
		// finding. Hunk 2 starts at new-file line 11 (three context lines, then
		// the finding as the fourth line of the hunk) so the finding's real
		// position is line 14 - an ordinal count of added lines across the whole
		// patch would instead call this line 2.
		const multiHunk = [
			"diff --git a/x.ts b/x.ts",
			"--- a/x.ts",
			"+++ b/x.ts",
			"@@ -1,3 +1,3 @@",
			" line1",
			"-old2",
			"+new2",
			" line3",
			"@@ -11,3 +11,4 @@",
			" line11",
			" line12",
			" line13",
			"+-----BEGIN RSA PRIVATE KEY-----",
		].join("\n");
		const findings = scanSecrets(multiHunk);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.line).toBe(14);
	});

	it("does not misread a deleted file's '+++ /dev/null' header as added content", () => {
		const deletion = [
			"diff --git a/key.pem b/key.pem",
			"deleted file mode 100644",
			"--- a/key.pem",
			"+++ /dev/null",
			"@@ -1 +0,0 @@",
			"------BEGIN RSA PRIVATE KEY-----",
		].join("\n");
		expect(scanSecrets(deletion)).toEqual([]);
	});
});
