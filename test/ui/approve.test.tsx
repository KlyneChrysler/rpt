import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/app/terminalConfirm.js", () => ({ readFromControllingTerminal: vi.fn() }));

import { readApproval } from "../../src/app/approveRun.js";
import { initRepo } from "../../src/app/initRepo.js";
import { readFromControllingTerminal } from "../../src/app/terminalConfirm.js";
import { verifyRun } from "../../src/app/verifyRun.js";
import { App } from "../../src/ui/App.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

const ENTER = String.fromCharCode(13);

// Restored after every test: these are process-global and the approval path
// reads them at the moment a key is pressed, not at import time.
const stdinTTY = process.stdin.isTTY;
const stdoutTTY = process.stdout.isTTY;

beforeEach(() => {
	vi.mocked(readFromControllingTerminal).mockReset();
	// Stands in for a person reading the prompt and typing back what it asks for.
	vi.mocked(readFromControllingTerminal).mockImplementation(async (prompt: string) => /"([^"]+)"/.exec(prompt)?.[1] ?? "");
	delete process.env.CLAUDECODE;
	delete process.env.RPT_AGENT_CONTEXT;
});

afterEach(() => {
	process.stdin.isTTY = stdinTTY;
	process.stdout.isTTY = stdoutTTY;
	delete process.env.CLAUDECODE;
	delete process.env.RPT_AGENT_CONTEXT;
});

function asHumanAtATerminal(): void {
	process.stdin.isTTY = true;
	process.stdout.isTTY = true;
}

async function repoWithRun(): Promise<string> {
	const repo = await makeFixtureRepo();
	await initRepo(repo);
	await driveFakeAgent(repo, [
		{ kind: "start", transcriptPath: null },
		{ kind: "edit", path: "a.ts", body: "export const a = 1;\n" },
		{ kind: "stop" },
	]);
	await verifyRun(repo, 1);
	return repo;
}

function settle(ms = 120): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Opens the console, selects the run, and reaches the approval screen.
async function openApproval(repo: string): Promise<ReturnType<typeof render>> {
	const app = render(<App repoRoot={repo} />);
	await settle();
	app.stdin.write(ENTER);
	await settle();
	app.stdin.write("a");
	await settle();
	return app;
}

describe("approving from the console", () => {
	it("records a real approval when a human presses y", async () => {
		const repo = await repoWithRun();
		asHumanAtATerminal();
		const app = await openApproval(repo);
		app.stdin.write("y");
		await settle(400);

		const approval = await readApproval(repo, 1);
		expect(approval?.decision).toBe("approved");
		expect(app.lastFrame()).toContain("approved by");
	});

	it("records a rejection when a human presses n", async () => {
		const repo = await repoWithRun();
		asHumanAtATerminal();
		const app = await openApproval(repo);
		app.stdin.write("n");
		await settle(400);

		expect((await readApproval(repo, 1))?.decision).toBe("rejected");
	});

	// The load-bearing assertion of the whole console. The screen must go
	// through the same refusal the CLI does rather than having a softer path of
	// its own, and it must leave nothing behind on disk when it refuses.
	it("refuses inside a known agent context and writes nothing", async () => {
		const repo = await repoWithRun();
		asHumanAtATerminal();
		process.env.CLAUDECODE = "1";
		const app = await openApproval(repo);
		app.stdin.write("y");
		await settle(400);

		expect(app.lastFrame()).toMatch(/human/i);
		expect(await readApproval(repo, 1)).toBeNull();
	});

	it("refuses without an interactive terminal and writes nothing", async () => {
		const repo = await repoWithRun();
		process.stdin.isTTY = false;
		process.stdout.isTTY = false;
		const app = await openApproval(repo);
		app.stdin.write("y");
		await settle(400);

		expect(app.lastFrame()).toMatch(/terminal/i);
		expect(await readApproval(repo, 1)).toBeNull();
	});

	it("shows the refusal rather than crashing when the typed confirmation is wrong", async () => {
		const repo = await repoWithRun();
		asHumanAtATerminal();
		vi.mocked(readFromControllingTerminal).mockResolvedValue("not the phrase");
		const app = await openApproval(repo);
		app.stdin.write("y");
		await settle(400);

		expect(app.lastFrame()).toMatch(/confirmation/i);
		expect(await readApproval(repo, 1)).toBeNull();
	});
});
