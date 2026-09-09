#!/usr/bin/env node
import { join } from "node:path";
import { Command } from "commander";
import type { AgentEvent } from "../domain/events.js";
import { projectRun, type AgentRun } from "../domain/run.js";
import { loadRun } from "../app/loadRun.js";
import { initRepo } from "../app/initRepo.js";
import { readEvents } from "../store/eventLog.js";
import { findRepoRoot, rptDirOf } from "../store/paths.js";
import { readStartFailures } from "../store/startFailures.js";
import { latestEntries, openRun, readIndex } from "../store/runIndex.js";
import { runHookCommand } from "./hook.js";
import type { OutputFormat } from "./format.js";
import { renderActiveRun, renderRun, renderRunList, renderTimeline } from "./render.js";

const program = new Command();
program.name("rpt").description("AI agent flight recorder and verification engine");
program.option("--format <format>", "text, json or agent", "text");

program.command("init").description("install hooks and scaffolds").action(async () => {
	const report = await initRepo(process.cwd());
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
});

// The one command that must never fail hard: a hook that exits non-zero can block
// the agent's tool call, and rpt breaking the thing it observes is worse than rpt
// recording nothing. So an unresolvable root falls back to the working directory
// here rather than throwing, and whatever goes wrong downstream is recorded as a
// failed start instead (see runHookCommand).
program.command("hook").description("internal: consume an agent hook payload").action(async () => {
	const root = (await findRepoRoot(process.cwd())) ?? process.cwd();
	process.exitCode = await runHookCommand(root, await readStdin());
});

// openRun, not activeRun: activeRun is the gate's narrower predicate and excludes
// a run that is still running, which is exactly the run a user is asking about
// when they check status mid-session.
program.command("status").description("show the run in progress, if any").action(async () => {
	const root = await repoRoot();
	const entry = await openRun(rptDirOf(root));
	const run = entry === null ? null : await loadOpenRun(root, entry.id);
	process.stdout.write(`${renderActiveRun(run, formatOf())}\n`);
});

program.command("runs").description("list runs").action(async () => {
	const rptDir = rptDirOf(await repoRoot());
	const { entries, corruptLines } = await readIndex(rptDir);
	const startFailures = await readStartFailures(rptDir);
	process.stdout.write(
		`${renderRunList({ entries: latestEntries(entries), corruptLines, startFailures }, formatOf())}\n`,
	);
});

program.command("run <id>").description("show one run").action(async (id: string) => {
	const run = await loadRunOrThrow(await repoRoot(), parseRunId(id));
	process.stdout.write(`${renderRun(run, formatOf())}\n`);
});

program
	.command("events <id>")
	.alias("replay")
	.description("print the event timeline")
	.action(async (id: string) => {
		const runId = parseRunId(id);
		const { events, gapCount } = await readEvents(rptDirOf(await repoRoot()), runId);
		requireExistingRun(runId, events);
		process.stdout.write(renderTimeline(events, gapCount, formatOf()));
	});

// Read commands answer for a repository, not for a directory, and a repository
// that cannot be located is not the same fact as a repository with no runs. Saying
// so - with the directory the search started from - is the difference between a
// user fixing their `cd` and a user believing rpt recorded nothing.
async function repoRoot(): Promise<string> {
	const root = await findRepoRoot(process.cwd());
	if (root === null) {
		throw new Error(
			`no git repository or rpt directory found at or above ${process.cwd()} - run "rpt init" at your repository root`,
		);
	}
	return root;
}

// A row in the index whose event log cannot be projected is not "no active run":
// it is a run that was allocated an id and then never recorded anything, which is
// exactly what a failed start leaves behind. Answering "no active run" there would
// be the silence this whole tool exists to remove, so it is reported instead.
async function loadOpenRun(root: string, runId: number): Promise<AgentRun> {
	try {
		return await loadRun(root, runId);
	} catch {
		throw new Error(
			`run ${runId} is in the run index but recorded no events - the session that opened it never got started; see "rpt runs"`,
		);
	}
}

// A stale, mistyped, or non-numeric run id is the single most likely mistake a user
// makes with this tool. Number("abc") and Number("1.5") are both non-integers, so
// this catches typos before they ever reach the domain fold below.
function parseRunId(raw: string): number {
	const id = Number(raw);
	if (!Number.isInteger(id)) throw new Error(`invalid run id "${raw}" - expected a whole number, try "rpt runs" to see valid ids`);
	return id;
}

// loadRun's projectRun throws when the event log for a run is empty - true for a run
// id that was never allocated, and equally true for any command run in a repo that
// was never `rpt init`-ed. Translated here into one plain-English line instead of
// letting that domain error reach the terminal as a stack trace.
async function loadRunOrThrow(root: string, runId: number): Promise<AgentRun> {
	try {
		return await loadRun(root, runId);
	} catch (error) {
		throw new Error(missingRunMessage(runId, error));
	}
}

// An unknown run id used to print an empty timeline and exit zero here, while
// `rpt run` correctly errored for the same id - one command answering "nothing
// happened" to a question the other answered "no such run". projectRun holds the
// rule for what makes a run exist, so it is asked rather than restated; the
// projection itself is not needed, only its verdict.
function requireExistingRun(runId: number, events: AgentEvent[]): void {
	try {
		projectRun(runId, events);
	} catch (error) {
		throw new Error(missingRunMessage(runId, error));
	}
}

function missingRunMessage(runId: number, error: unknown): string {
	if (error instanceof Error && error.message.includes("does not begin with RunStarted")) {
		return `no run ${runId} found here - try "rpt runs" to see valid ids`;
	}
	return error instanceof Error ? error.message : String(error);
}

function formatOf(): OutputFormat {
	return program.opts<{ format: OutputFormat }>().format ?? "text";
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

// Every command above can reject: a bad run id, an unreadable index, a filesystem
// error. None of that is acceptable as a raw stack trace on stderr - text and agent
// formats get one plain line, json format still gets a parseable document on stdout
// so a piping consumer never has to special-case failure. The process-level handlers
// are a last-resort net for a rejection that somehow escapes the command action
// itself (a future command that doesn't await something it starts, for example).
function reportFailure(error: unknown): void {
	process.exitCode = 1;
	const message = error instanceof Error ? error.message : String(error);
	if (formatOf() === "json") {
		process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
		return;
	}
	process.stderr.write(`rpt: ${message}\n`);
}

process.on("uncaughtException", reportFailure);
process.on("unhandledRejection", reportFailure);

try {
	await program.parseAsync(process.argv);
} catch (error) {
	reportFailure(error);
}
