import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleHook, runHookCommand } from "../../src/cli/hook.js";
import { loadRun } from "../../src/app/loadRun.js";
import { readEvents } from "../../src/store/eventLog.js";
import { activeRun, listRuns } from "../../src/store/runIndex.js";
import { rptDirOf } from "../../src/store/paths.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

async function fixture(name: string): Promise<unknown> {
	return JSON.parse(await readFile(join("test/fixtures/hooks", `${name}.json`), "utf8"));
}

describe("handleHook", () => {
	it("starts a run with an empty task, never the 'agent session' placeholder", async () => {
		const repo = await makeFixtureRepo();
		await handleHook(repo, await fixture("SessionStart"));
		const run = await loadRun(repo, 1);
		expect(run.task).toBe("");
		expect(run.task).not.toBe("agent session");
	});

	it("derives the task from the first prompt end to end", async () => {
		const repo = await makeFixtureRepo();
		await handleHook(repo, await fixture("SessionStart"));
		await handleHook(repo, await fixture("UserPromptSubmit"));
		await handleHook(repo, await fixture("Stop"));

		const run = await loadRun(repo, 1);
		expect(run.state).toBe("ENDED");
		expect(run.task).toBe("fixture prompt");

		const row = (await listRuns(rptDirOf(repo))).find((entry) => entry.id === 1);
		expect(row?.task).toBe("fixture prompt");
	});

	// Controller ruling: a run is sealed exactly once. A duplicate Stop (the agent
	// re-firing the hook, or one arriving with no run in progress at all) must not
	// throw and must not append a second AgentStopped record.
	it("treats a duplicate Stop hook as already-sealed, not an error", async () => {
		const repo = await makeFixtureRepo();
		await handleHook(repo, await fixture("SessionStart"));
		await handleHook(repo, await fixture("Stop"));

		await expect(handleHook(repo, await fixture("Stop"))).resolves.toBeUndefined();

		const { events } = await readEvents(rptDirOf(repo), 1);
		expect(events.filter((event) => event.kind === "AgentStopped")).toHaveLength(1);
		expect((await loadRun(repo, 1)).state).toBe("ENDED");
	});

	it("does nothing when Stop fires with no run ever started", async () => {
		const repo = await makeFixtureRepo();
		await expect(handleHook(repo, await fixture("Stop"))).resolves.toBeUndefined();
		expect(await activeRun(rptDirOf(repo))).toBeNull();
	});

	// Controller ruling: the current-run pointer names at most one run. A SessionStart
	// while a run is still open (its Stop hook never fired) seals the stale run first
	// so the pointer - and every event after it - never attaches to the wrong run.
	it("seals a stale run before starting a new one on a second SessionStart", async () => {
		const repo = await makeFixtureRepo();
		await handleHook(repo, await fixture("SessionStart"));
		await handleHook(repo, await fixture("SessionStart"));

		expect((await loadRun(repo, 1)).state).toBe("ENDED");
		const second = await loadRun(repo, 2);
		expect(second.state).toBe("RUNNING");

		await handleHook(repo, await fixture("UserPromptSubmit"));
		const first = await loadRun(repo, 1);
		expect(first.claims.mutatedPaths).toEqual([]);
		expect((await loadRun(repo, 2)).task).toBe("fixture prompt");
	});
});

describe("runHookCommand", () => {
	it("always exits 0, even for stdin that isn't JSON", async () => {
		const repo = await makeFixtureRepo();
		expect(await runHookCommand(repo, "not json")).toBe(0);
	});

	it("exits 0 for a well-formed hook payload", async () => {
		const repo = await makeFixtureRepo();
		const stdin = JSON.stringify(await fixture("SessionStart"));
		expect(await runHookCommand(repo, stdin)).toBe(0);
		expect((await loadRun(repo, 1)).state).toBe("RUNNING");
	});

	it("exits 0 even when the underlying use case throws", async () => {
		const repo = await makeFixtureRepo();
		const notADirectory = join(repo, "not-a-dir");
		await writeFile(notADirectory, "");
		const stdin = JSON.stringify(await fixture("SessionStart"));
		await expect(runHookCommand(notADirectory, stdin)).resolves.toBe(0);
	});
});
