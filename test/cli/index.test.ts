import { execFile, execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { handleHook, runHookCommand } from "../../src/cli/hook.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = join(repoRoot, "dist/cli/index.js");
const tscBin = join(repoRoot, "node_modules/.bin/tsc");

// These tests exercise the actual built binary, not the source - a raw stack trace
// or a broken json pipe is a property of what `node dist/cli/index.js` prints, not
// of any function in isolation, so a fresh build is the only faithful way to check it.
beforeAll(() => {
	execFileSync(tscBin, ["-p", join(repoRoot, "tsconfig.json")]);
}, 60_000);

type CliResult = { stdout: string; stderr: string; exitCode: number };

function runCli(args: string[], cwd: string): Promise<CliResult> {
	return new Promise((resolve) => {
		execFile("node", [cliPath, ...args], { cwd }, (error, stdout, stderr) => {
			resolve({ stdout, stderr, exitCode: exitCodeOf(error) });
		});
	});
}

function exitCodeOf(error: (Error & { code?: unknown }) | null): number {
	if (error === null) return 0;
	return typeof error.code === "number" ? error.code : 1;
}

async function fixture(name: string): Promise<unknown> {
	return JSON.parse(await readFile(join("test/fixtures/hooks", `${name}.json`), "utf8"));
}

async function repoWithOneEndedRun(): Promise<string> {
	const repo = await makeFixtureRepo();
	await handleHook(repo, await fixture("SessionStart"));
	await handleHook(repo, await fixture("Stop"));
	return repo;
}

describe("rpt run <id>: bad input never reaches the terminal as a stack trace", () => {
	it("reports one clear stderr line and a non-zero exit for a run id that does not exist", async () => {
		const repo = await repoWithOneEndedRun();
		const result = await runCli(["run", "999"], repo);

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr.trim().split("\n")).toHaveLength(1);
		expect(result.stderr).toContain("999");
	});

	it("reports one clear stderr line and a non-zero exit for a non-numeric run id", async () => {
		const repo = await repoWithOneEndedRun();
		const result = await runCli(["run", "abc"], repo);

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr.trim().split("\n")).toHaveLength(1);
		expect(result.stderr).toContain("abc");
	});

	it("reports one clear stderr line and a non-zero exit in a directory that was never initialised", async () => {
		const repo = await makeFixtureRepo();
		const result = await runCli(["run", "1"], repo);

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr.trim().split("\n")).toHaveLength(1);
	});

	it("emits a valid json error document on stdout, not a stack trace, in json format", async () => {
		const repo = await repoWithOneEndedRun();
		const result = await runCli(["run", "999", "--format", "json"], repo);

		expect(result.exitCode).not.toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(typeof parsed.error).toBe("string");
		expect(parsed.error.length).toBeGreaterThan(0);
	});
});

describe("rpt status: format-aware emptiness", () => {
	it("emits parseable json with a null active run when there is no run to show", async () => {
		const repo = await makeFixtureRepo();
		const result = await runCli(["status", "--format", "json"], repo);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ active: null });
	});

	it("says there is no active run in text format", async () => {
		const repo = await makeFixtureRepo();
		const result = await runCli(["status"], repo);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("no active run");
	});
});

// The reviewer reproduced this against the built binary: one structurally-wrong
// line in the index used to crash the listing permanently and poison the next id
// allocation, with nothing but a stderr line in a hook nobody reads to show for it.
describe("rpt runs: one bad index line does not wedge the recorder", () => {
	it("still lists the good runs and says the index is damaged", async () => {
		const repo = await repoWithOneEndedRun();
		await appendFile(join(repo, ".rpt/index.jsonl"), "42\n");

		const result = await runCli(["runs"], repo);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/corrupt/i);
		expect(result.stdout).toContain("ENDED");
	});

	it("emits parseable json naming the corrupt line count", async () => {
		const repo = await repoWithOneEndedRun();
		await appendFile(join(repo, ".rpt/index.jsonl"), "42\n");

		const result = await runCli(["runs", "--format", "json"], repo);

		const parsed = JSON.parse(result.stdout);
		expect(parsed.corruptLines).toBe(1);
		expect(parsed.runs).toHaveLength(1);
	});
});

// Running from a subdirectory is the normal case, not the exception: an agent's
// hooks fire wherever the session happens to be. Treating the working directory
// as the repository root made every one of those look like a repository with no
// history at all, and said so with a clean exit code.
describe("rpt finds the repository from anywhere inside it", () => {
	it("lists the repository's runs from a subdirectory", async () => {
		const repo = await repoWithOneEndedRun();
		const nested = join(repo, "src/deep");
		await mkdir(nested, { recursive: true });

		const result = await runCli(["runs", "--format", "json"], nested);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout).runs).toHaveLength(1);
	});

	it("says explicitly that it found no repository rather than reporting an empty history", async () => {
		const bare = await mkdtemp(join(tmpdir(), "rpt-bare-"));

		const result = await runCli(["runs"], bare);

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(/no git repository|not inside/i);
	});
});

describe("rpt status: what is happening right now", () => {
	// The listing showing a RUNNING run while status said there was none is exactly
	// the contradiction a user hits at the one moment they check: mid-session.
	it("shows the run that is still running rather than claiming there is none", async () => {
		const repo = await makeFixtureRepo();
		await handleHook(repo, await fixture("SessionStart"));

		const result = await runCli(["status", "--format", "json"], repo);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout).id).toBe(1);
	});

	it("agrees with the run listing while a run is live", async () => {
		const repo = await makeFixtureRepo();
		await handleHook(repo, await fixture("SessionStart"));

		const listed = JSON.parse((await runCli(["runs", "--format", "json"], repo)).stdout);
		const status = JSON.parse((await runCli(["status", "--format", "json"], repo)).stdout);

		expect(listed.runs[0].id).toBe(status.id);
	});
});

describe("rpt events", () => {
	it("errors for a run id that does not exist instead of printing nothing", async () => {
		const repo = await repoWithOneEndedRun();

		const result = await runCli(["events", "999"], repo);

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("999");
	});

	it("warns about a gapped log the way the run summary already does", async () => {
		const repo = await repoWithOneEndedRun();
		await appendFile(join(repo, ".rpt/runs/1/events.jsonl"), '{"runId":1,"seq":9,"kind":"Fi');

		const result = await runCli(["events", "1"], repo);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/gap/i);
	});
});

describe("rpt runs: a session that never recorded anything", () => {
	it("says a run failed to start rather than showing an empty history", async () => {
		const bare = await mkdtemp(join(tmpdir(), "rpt-bare-"));
		await runHookCommand(bare, JSON.stringify(await fixture("SessionStart")));

		const result = await runCli(["runs"], bare);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/failed to start/i);
	});

	it("carries the failed starts in json too", async () => {
		const bare = await mkdtemp(join(tmpdir(), "rpt-bare-"));
		await runHookCommand(bare, JSON.stringify(await fixture("SessionStart")));

		const result = await runCli(["runs", "--format", "json"], bare);

		expect(JSON.parse(result.stdout).startFailures).toHaveLength(1);
	});
});
