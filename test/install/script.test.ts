import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IS_WINDOWS, projectRoot } from "../support/platform.js";

const SCRIPT = join(projectRoot, "install.sh");

async function script(): Promise<string> {
	return readFile(SCRIPT, "utf8");
}

async function packageJson(): Promise<{ name: string; version: string; engines: { node: string } }> {
	return JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
}

describe("the install script", () => {
	it("is a shell script and is executable", async () => {
		expect((await script()).startsWith("#!/bin/sh")).toBe(true);
		if (!IS_WINDOWS) expect((await stat(SCRIPT)).mode & 0o111).not.toBe(0);
	});

	// sh is not a given on Windows, and this asserts a property of the script
	// rather than of the platform running the suite.
	it.skipIf(IS_WINDOWS)("parses", () => {
		expect(() => execFileSync("sh", ["-n", SCRIPT])).not.toThrow();
	});

	it("exits on the first failure rather than continuing", async () => {
		expect(await script()).toContain("set -eu");
	});

	// The rot this catches: the script builds the release asset's filename from
	// the package name, so renaming the package silently points every install at
	// a URL that does not exist.
	it("builds an asset name that matches what npm pack produces", async () => {
		const { name } = await packageJson();
		expect(await script()).toContain(`TARBALL="${name}-\${VERSION#v}.tgz"`);
	});

	it("requires the same node version the package does", async () => {
		const { engines } = await packageJson();
		const major = /(\d+)/.exec(engines.node)?.[1];
		expect(await script()).toContain(`MIN_NODE_MAJOR=${major}`);
	});

	it("verifies a checksum rather than trusting the download", async () => {
		const body = await script();
		expect(body).toContain(".sha256");
		expect(body).toMatch(/checksum mismatch/);
	});

	it("cleans up its temporary directory on every exit path", async () => {
		expect(await script()).toMatch(/trap 'rm -rf "\$workdir"' EXIT INT TERM/);
	});

	it("checks for every command it goes on to use", async () => {
		const body = await script();
		for (const tool of ["node", "npm", "curl"]) {
			expect(body).toContain(`need ${tool}`);
		}
	});

	// A README that tells people to pipe a URL into a shell has to name a URL
	// that serves this file.
	it("is the file the README tells people to run", async () => {
		const readme = await readFile(join(projectRoot, "README.md"), "utf8");
		const url = /https:\/\/raw\.githubusercontent\.com\/\S+install\.sh/.exec(readme)?.[0];
		expect(url).toBeDefined();
		expect(url).toContain("/main/install.sh");
	});
});
