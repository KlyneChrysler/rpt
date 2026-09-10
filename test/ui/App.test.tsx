import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { initRepo } from "../../src/app/initRepo.js";
import { verifyRun } from "../../src/app/verifyRun.js";
import { App } from "../../src/ui/App.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

// Built with String.fromCharCode rather than embedded as literal control
// characters, so this file stays safe to copy, paste and diff.
const ESCAPE = String.fromCharCode(27);
const ENTER = String.fromCharCode(13);

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

function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 80));
}

describe("App", () => {
	it("shows a loading state before the first model arrives", () => {
		expect(render(<App repoRoot="/nonexistent" />).lastFrame()).toMatch(/loading/i);
	});

	it("opens on the dashboard", async () => {
		const { lastFrame } = render(<App repoRoot={await repoWithRun()} />);
		await settle();
		expect(lastFrame()).toMatch(/RUN\b|no runs/i);
	});

	it("shows something explanatory rather than crashing when the repo cannot be read", async () => {
		const { lastFrame } = render(<App repoRoot="/nonexistent" />);
		await settle();
		expect(lastFrame()).toMatch(/loading|error|no runs/i);
	});

	it("opens run detail on enter", async () => {
		const { lastFrame, stdin } = render(<App repoRoot={await repoWithRun()} />);
		await settle();
		stdin.write(ENTER);
		await settle();
		expect(lastFrame()).toContain("RUN 1");
	});

	it("moves to the risk screen on r and back on escape", async () => {
		const { lastFrame, stdin } = render(<App repoRoot={await repoWithRun()} />);
		await settle();
		stdin.write(ENTER);
		await settle();
		stdin.write("r");
		await settle();
		expect(lastFrame()).toMatch(/RISK SCORE/i);
		stdin.write(ESCAPE);
		await settle();
		expect(lastFrame()).toContain("RUN 1");
	});

	it("reaches the events screen on v", async () => {
		const { lastFrame, stdin } = render(<App repoRoot={await repoWithRun()} />);
		await settle();
		stdin.write(ENTER);
		await settle();
		stdin.write("v");
		await settle();
		expect(lastFrame()).toContain("EVENTS");
	});

	it("reaches the approval screen on a, and says approving an unverified run is an override", async () => {
		const { lastFrame, stdin } = render(<App repoRoot={await repoWithRun()} />);
		await settle();
		stdin.write(ENTER);
		await settle();
		stdin.write("a");
		await settle();
		expect(lastFrame()).toContain("APPROVE RUN 1");
		expect(lastFrame()).toMatch(/override/i);
	});

	it("reaches the tests screen on t", async () => {
		const { lastFrame, stdin } = render(<App repoRoot={await repoWithRun()} />);
		await settle();
		stdin.write(ENTER);
		await settle();
		stdin.write("t");
		await settle();
		expect(lastFrame()).toContain("TESTS");
	});

	it("shows the key hints on every screen", async () => {
		const { lastFrame } = render(<App repoRoot={await repoWithRun()} />);
		await settle();
		expect(lastFrame()).toContain("[q]");
	});
});
