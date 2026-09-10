import { execFile, execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { initRepo } from "../../src/app/initRepo.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = join(projectRoot, "dist/cli/index.js");
const COMMANDS = join("plugin", "commands");

beforeAll(() => {
	execFileSync(join(projectRoot, "node_modules/.bin/tsc"), ["-p", join(projectRoot, "tsconfig.json")]);
}, 120_000);

// The rpt invocation each command file tells the agent to run, taken from the
// file rather than hard-coded here. That is the point of this suite: asserting
// that a command file contains the string "--format=agent" proves nothing about
// whether the command in it works, and a file can drift into naming a verb or a
// flag that no longer exists with every existing plugin test still green.
async function invocationsIn(file: string): Promise<string[]> {
	const body = await readFile(join(COMMANDS, file), "utf8");
	return [...body.matchAll(/`(rpt [^`]+)`/g)].map((match) => match[1]!);
}

function run(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve) => {
		execFile("node", [cliPath, ...args], { cwd }, (error, stdout, stderr) => {
			const code = (error as (Error & { code?: unknown }) | null)?.code;
			resolve({ stdout, stderr, code: error === null ? 0 : typeof code === "number" ? code : 1 });
		});
	});
}

// $ARGUMENTS is substituted by Claude Code with whatever the user typed. Run 1
// stands in for it, and dropping it entirely covers the no-argument case each
// command file describes.
function withRunId(invocation: string, runId: string): string[] {
	return invocation.replace("$ARGUMENTS", runId).split(" ").slice(1).filter((part) => part !== "");
}

async function repoWithVerifiedRun(): Promise<string> {
	const repo = await makeFixtureRepo();
	await initRepo(repo);
	await driveFakeAgent(repo, [
		{ kind: "start", transcriptPath: null },
		{ kind: "edit", path: "a.ts", body: "export const a = 1;\n" },
		{ kind: "stop" },
	]);
	await run(["verify", "1"], repo);
	return repo;
}

describe("every command the plugin ships actually runs", () => {
	it("exits zero and prints something for each one", async () => {
		const repo = await repoWithVerifiedRun();
		for (const file of await readdir(COMMANDS)) {
			for (const invocation of await invocationsIn(file)) {
				const result = await run(withRunId(invocation, "1"), repo);
				expect(`${file}: ${invocation} -> exit ${result.code}`).toBe(`${file}: ${invocation} -> exit 0`);
				expect(result.stdout.trim().length).toBeGreaterThan(0);
			}
		}
	}, 120_000);

	it("keeps every agent-format response inside a sane context budget", async () => {
		const repo = await repoWithVerifiedRun();
		for (const file of await readdir(COMMANDS)) {
			for (const invocation of await invocationsIn(file)) {
				const result = await run(withRunId(invocation, "1"), repo);
				expect(`${file} -> ${result.stdout.length} chars`).toBe(`${file} -> ${Math.min(result.stdout.length, 2000)} chars`);
			}
		}
	}, 120_000);

	it("never emits terminal escape sequences into an agent's context", async () => {
		const repo = await repoWithVerifiedRun();
		for (const file of await readdir(COMMANDS)) {
			for (const invocation of await invocationsIn(file)) {
				const result = await run(withRunId(invocation, "1"), repo);
				expect(result.stdout).not.toContain(String.fromCharCode(27));
			}
		}
	}, 120_000);
});
