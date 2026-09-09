#!/usr/bin/env node
import { join } from "node:path";
import { Command } from "commander";
import type { AgentRun } from "../domain/run.js";
import { loadRun } from "../app/loadRun.js";
import { initRepo } from "../app/initRepo.js";
import { readEvents } from "../store/eventLog.js";
import { rptDirOf } from "../store/paths.js";
import { activeRun, latestEntries, readIndex } from "../store/runIndex.js";
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

program.command("hook").description("internal: consume an agent hook payload").action(async () => {
	process.exitCode = await runHookCommand(process.cwd(), await readStdin());
});

program.command("status").description("show the active run").action(async () => {
	const entry = await activeRun(rptDirOf(process.cwd()));
	const run = entry === null ? null : await loadRun(process.cwd(), entry.id);
	process.stdout.write(`${renderActiveRun(run, formatOf())}\n`);
});

program.command("runs").description("list runs").action(async () => {
	const { entries, corruptLines } = await readIndex(rptDirOf(process.cwd()));
	process.stdout.write(`${renderRunList({ entries: latestEntries(entries), corruptLines }, formatOf())}\n`);
});

program.command("run <id>").description("show one run").action(async (id: string) => {
	const run = await loadRunOrThrow(parseRunId(id));
	process.stdout.write(`${renderRun(run, formatOf())}\n`);
});

program
	.command("events <id>")
	.alias("replay")
	.description("print the event timeline")
	.action(async (id: string) => {
		const { events } = await readEvents(rptDirOf(process.cwd()), parseRunId(id));
		process.stdout.write(renderTimeline(events, formatOf()));
	});

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
async function loadRunOrThrow(runId: number): Promise<AgentRun> {
	try {
		return await loadRun(process.cwd(), runId);
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
