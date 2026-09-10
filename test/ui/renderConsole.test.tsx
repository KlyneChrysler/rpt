import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { initRepo } from "../../src/app/initRepo.js";
import { renderConsole } from "../../src/ui/renderConsole.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

// Ink writes to a stream and reads keys from another. Standing in for both is
// the whole of what this adapter does, so faking them tests the real thing
// rather than a stub of it.
type FakeStdout = EventEmitter & { write(chunk: string): boolean; columns: number; rows: number; frames: string[] };

function fakeStdout(): FakeStdout {
	const stdout = new EventEmitter() as FakeStdout;
	stdout.frames = [];
	stdout.columns = 100;
	stdout.rows = 40;
	stdout.write = (chunk: string) => (stdout.frames.push(chunk), true);
	return stdout;
}

type FakeStdin = EventEmitter & {
	isTTY: boolean;
	write(data: string): void;
	read(): string | null;
	setRawMode(): void;
	setEncoding(): void;
	resume(): void;
	pause(): void;
	ref(): void;
	unref(): void;
};

// Ink takes a keypress through the readable/read pair, not through a bare
// "data" event, so a fake that only emits "data" renders correctly and then
// ignores every key - which looks exactly like a hung test.
function fakeStdin(): FakeStdin {
	const stdin = new EventEmitter() as FakeStdin;
	let pending: string | null = null;
	const noop = (): void => {};
	stdin.isTTY = true;
	stdin.write = (data: string) => {
		pending = data;
		stdin.emit("readable");
		stdin.emit("data", data);
	};
	stdin.read = () => {
		const data = pending;
		pending = null;
		return data;
	};
	stdin.setRawMode = noop;
	stdin.setEncoding = noop;
	stdin.resume = noop;
	stdin.pause = noop;
	stdin.ref = noop;
	stdin.unref = noop;
	return stdin;
}

async function repoWithRun(): Promise<string> {
	const repo = await makeFixtureRepo();
	await initRepo(repo);
	await driveFakeAgent(repo, [
		{ kind: "start", transcriptPath: null },
		{ kind: "edit", path: "a.ts", body: "export const a = 1;\n" },
		{ kind: "stop" },
	]);
	return repo;
}

describe("renderConsole", () => {
	it("renders the console and resolves when the user quits", async () => {
		const stdout = fakeStdout();
		const stdin = fakeStdin();
		const repo = await repoWithRun();

		const finished = renderConsole(repo, { stdout, stdin, exitOnCtrlC: false, patchConsole: false } as never);
		await new Promise((resolve) => setTimeout(resolve, 300));
		stdin.write("q");

		await expect(finished).resolves.toBeUndefined();
		expect(stdout.frames.join("")).toContain("Agent Verification Engine");
	}, 20_000);

	it("shows the run it loaded, not just a frame", async () => {
		const stdout = fakeStdout();
		const stdin = fakeStdin();
		const repo = await repoWithRun();

		const finished = renderConsole(repo, { stdout, stdin, exitOnCtrlC: false, patchConsole: false } as never);
		await new Promise((resolve) => setTimeout(resolve, 300));
		stdin.write("q");
		await finished;

		expect(stdout.frames.join("")).toMatch(/RUN/);
	}, 20_000);
});
