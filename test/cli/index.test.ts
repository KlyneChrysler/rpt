import { execFile, execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { handleHook, runHookCommand } from "../../src/cli/hook.js";
import { allocateRunId } from "../../src/store/runIndex.js";
import { rptDirOf } from "../../src/store/paths.js";
import { recordStartFailure } from "../../src/store/startFailures.js";
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

	// The row a failed start leaves behind is a run with an id and no events: the id
	// is allocated before the git snapshot that throws. Reporting "no active run"
	// for it would be exactly the silence this tool exists to remove, so status
	// names it instead. The recorded reason is what separates this from a run that
	// is merely still starting, which is a normal state and not an error.
	it("does not let rpt status answer 'no active run' for a run that recorded nothing", async () => {
		const repo = await repoWithOneEndedRun();
		const reserved = { id: 7, task: "", state: "RUNNING", startedAt: "2020-01-01T00:00:00.000Z", endedAt: null };
		await appendFile(join(repo, ".rpt/index.jsonl"), `${JSON.stringify(reserved)}\n`);
		await recordStartFailure(rptDirOf(repo), "snapshot failed");

		const result = await runCli(["status"], repo);

		expect(result.stdout).not.toContain("no active run");
		expect(result.stderr).toContain("7");
		expect(result.exitCode).not.toBe(0);
	});

	it("carries the failed starts in json too", async () => {
		const bare = await mkdtemp(join(tmpdir(), "rpt-bare-"));
		await runHookCommand(bare, JSON.stringify(await fixture("SessionStart")));

		const result = await runCli(["runs", "--format", "json"], bare);

		expect(JSON.parse(result.stdout).startFailures).toHaveLength(1);
	});
});

// The run this whole tool exists for: a crash tore the RunStarted line off the
// front of the log. Every surviving event is still evidence, and the timeline is
// the surface that shows it. Answering "no such run" here is missing evidence
// reading as nonexistence, which inverts the project's premise.
async function repoWithATornStartEvent(): Promise<string> {
	const repo = await repoWithOneEndedRun();
	const logPath = join(repo, ".rpt/runs/1/events.jsonl");
	const lines = (await readFile(logPath, "utf8")).split("\n");
	lines[0] = '{"runId":1,"seq":0,"kind":"RunSta';
	await writeFile(logPath, lines.join("\n"));
	return repo;
}

describe("a run whose start event was lost to a torn write", () => {
	it("prints the timeline that survived rather than denying the run exists", async () => {
		const repo = await repoWithATornStartEvent();

		const result = await runCli(["events", "1"], repo);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("AgentStopped");
		expect(result.stdout).toMatch(/gap/i);
	});

	it("tells rpt run that the run is damaged, not that it is absent", async () => {
		const repo = await repoWithATornStartEvent();

		const result = await runCli(["run", "1"], repo);

		expect(result.stderr).toMatch(/damaged/i);
		expect(result.stderr).not.toMatch(/no run 1 found/i);
	});

	it("does not let the listing and the detail commands disagree about it existing", async () => {
		const repo = await repoWithATornStartEvent();

		const listed = JSON.parse((await runCli(["runs", "--format", "json"], repo)).stdout);
		const detail = await runCli(["run", "1"], repo);

		expect(listed.runs.map((entry: { id: number }) => entry.id)).toContain(1);
		expect(detail.stderr).not.toMatch(/no run 1 found/i);
	});

	it("still says a genuinely absent run is absent", async () => {
		const repo = await repoWithATornStartEvent();

		const result = await runCli(["events", "999"], repo);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toMatch(/no run 999 found/i);
	});
});

// The window between the index row being reserved and RunStarted being appended is
// a normal part of every session, and on a large repository the git snapshot in
// between takes seconds. A run that is starting is not a run that failed to start.
describe("rpt status during a normal run start", () => {
	it("reports the run as starting, and exits zero", async () => {
		const repo = await makeFixtureRepo();
		await allocateRunId(rptDirOf(repo));

		const result = await runCli(["status"], repo);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/starting/i);
		expect(result.stdout).not.toMatch(/failed to start/i);
	});

	it("still reports a start that actually failed", async () => {
		const repo = await makeFixtureRepo();
		await allocateRunId(rptDirOf(repo));
		await recordStartFailure(rptDirOf(repo), "not a git repository");

		const result = await runCli(["status"], repo);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toMatch(/failed to start/i);
		expect(result.stderr).toContain("not a git repository");
	});
});
