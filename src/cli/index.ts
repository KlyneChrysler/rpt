#!/usr/bin/env node
import { join } from "node:path";
import { Command } from "commander";
import { loadRun } from "../app/loadRun.js";
import { initRepo } from "../app/initRepo.js";
import { readEvents } from "../store/eventLog.js";
import { rptDirOf } from "../store/paths.js";
import { activeRun, readIndex, type RunIndexEntry } from "../store/runIndex.js";
import { runHookCommand } from "./hook.js";
import type { OutputFormat } from "./format.js";
import { renderRun, renderRunList, renderTimeline } from "./render.js";

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
	if (entry === null) {
		process.stdout.write("no active run\n");
		return;
	}
	process.stdout.write(`${renderRun(await loadRun(process.cwd(), entry.id), formatOf())}\n`);
});

program.command("runs").description("list runs").action(async () => {
	const { entries, corruptLines } = await readIndex(join(rptDirOf(process.cwd()), "index.jsonl"));
	process.stdout.write(`${renderRunList({ entries: latestPerRun(entries), corruptLines }, formatOf())}\n`);
});

program.command("run <id>").description("show one run").action(async (id: string) => {
	process.stdout.write(`${renderRun(await loadRun(process.cwd(), Number(id)), formatOf())}\n`);
});

program
	.command("events <id>")
	.alias("replay")
	.description("print the event timeline")
	.action(async (id: string) => {
		const { events } = await readEvents(rptDirOf(process.cwd()), Number(id));
		process.stdout.write(renderTimeline(events, formatOf()));
	});

// The index is an append-only log: a run gets a RUNNING placeholder row when its id
// is allocated, then further rows as its state changes. readIndex hands back every
// row it parsed, so listing runs means folding to the latest row per id first - the
// same fold listRuns does, kept local here since readIndex (not listRuns) is what
// carries the corruptLines count this command needs to show.
function latestPerRun(entries: RunIndexEntry[]): RunIndexEntry[] {
	const latest = new Map<RunIndexEntry["id"], RunIndexEntry>();
	for (const entry of entries) latest.set(entry.id, entry);
	return [...latest.values()].sort((left, right) => right.id - left.id);
}

function formatOf(): OutputFormat {
	return program.opts<{ format: OutputFormat }>().format;
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

await program.parseAsync(process.argv);
