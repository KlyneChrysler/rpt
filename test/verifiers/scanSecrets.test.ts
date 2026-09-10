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
});
