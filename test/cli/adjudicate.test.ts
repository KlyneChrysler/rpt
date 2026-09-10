import { execFile, execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { initRepo } from "../../src/app/initRepo.js";
import { git } from "../../src/git/exec.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = join(projectRoot, "dist/cli/index.js");
const tscBin = join(projectRoot, "node_modules/.bin/tsc");

beforeAll(() => {
	execFileSync(tscBin, ["-p", join(projectRoot, "tsconfig.json")]);
}, 120_000);

type CliResult = { stdout: string; stderr: string; exitCode: number };

// The agent markers are stripped from the inherited environment and only put
// back by a test that is deliberately exercising them: this suite frequently
// runs inside an agent session itself, and inheriting that marker would make
// every approval refusal look like the agent-context refusal regardless of
// what was actually being tested.
function runCli(args: string[], cwd: string, env: Record<string, string> = {}): Promise<CliResult> {
	const { CLAUDECODE, RPT_AGENT_CONTEXT, RPT_BYPASS, ...inherited } = process.env;
	return new Promise((resolve) => {
		execFile("node", [cliPath, ...args], { cwd, env: { ...inherited, ...env } }, (error, stdout, stderr) => {
			const code = (error as (Error & { code?: unknown }) | null)?.code;
			resolve({ stdout, stderr, exitCode: error === null ? 0 : typeof code === "number" ? code : 1 });
		});
	});
}

async function repoWithEndedRun(): Promise<string> {
	const repo = await makeFixtureRepo();
	await initRepo(repo);
	await driveFakeAgent(repo, [
		{ kind: "start", transcriptPath: null },
		{ kind: "edit", path: "a.ts", body: "export const a = 1;\n" },
		{ kind: "stop" },
	]);
	return repo;
}

describe("rpt verify and rpt risk", () => {
	it("verifies a run and names the verdict", async () => {
		const repo = await repoWithEndedRun();
		const result = await runCli(["verify", "1"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/VERDICT: (VERIFIED|FAILED|UNVERIFIED)/);
	});

	it("refuses to show risk for a run that has not been verified, and says what to run", async () => {
		const repo = await repoWithEndedRun();
		const result = await runCli(["risk", "1"], repo);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("rpt verify 1");
	});

	it("shows an itemised assessment once the run has been verified", async () => {
		const repo = await repoWithEndedRun();
		await runCli(["verify", "1"], repo);
		const result = await runCli(["risk", "1"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("RISK SCORE");
	});

	it("emits a parseable risk document in json format", async () => {
		const repo = await repoWithEndedRun();
		await runCli(["verify", "1"], repo);
		const result = await runCli(["--format", "json", "risk", "1"], repo);
		expect(typeof JSON.parse(result.stdout).score).toBe("number");
	});
});

describe("rpt diff", () => {
	it("prints the diff rpt observed for the run", async () => {
		const repo = await repoWithEndedRun();
		const result = await runCli(["diff", "1"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("a.ts");
	});
});

describe("rpt approve", () => {
	it("refuses inside a known agent context and exits non-zero", async () => {
		const repo = await repoWithEndedRun();
		await runCli(["verify", "1"], repo);
		const result = await runCli(["approve", "1"], repo, { RPT_AGENT_CONTEXT: "1" });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/human/i);
	});

	it("refuses without an interactive terminal, rather than recording a decision nobody made", async () => {
		const repo = await repoWithEndedRun();
		await runCli(["verify", "1"], repo);
		const result = await runCli(["approve", "1"], repo);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/terminal/i);
	});
});

describe("rpt gate", () => {
	it("exits zero in a repository with no run to adjudicate", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		expect((await runCli(["gate"], repo)).exitCode).toBe(0);
	});

	it("exits one and explains itself when a run needs a human", async () => {
		const repo = await repoWithEndedRun();
		const result = await runCli(["gate"], repo);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("commit blocked");
		expect(result.stdout).toBe("");
	});

	it("exits zero under an explicit bypass", async () => {
		const repo = await repoWithEndedRun();
		expect((await runCli(["gate"], repo, { RPT_BYPASS: "1" })).exitCode).toBe(0);
	});
});

describe("rpt record", () => {
	it("exits zero and prints nothing when asked to be quiet", async () => {
		const repo = await repoWithEndedRun();
		await runCli(["verify", "1"], repo);
		await writeFile(join(repo, "a.ts"), "export const a = 1;\n");
		await git(repo, ["add", "-A"]);
		await git(repo, ["commit", "-q", "-m", "change", "--no-verify"]);
		const result = await runCli(["record", "--quiet"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
		expect(await git(repo, ["notes", "--ref=rpt", "show", "HEAD"])).toContain("run 1");
	});

	it("exits zero even where there is nothing to record", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		expect((await runCli(["record"], repo)).exitCode).toBe(0);
	});
});
