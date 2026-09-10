#!/usr/bin/env node
import { Command } from "commander";
import type { AgentRun } from "../domain/run.js";
import type { RunId } from "../domain/events.js";
import { actorFromEnvironment, approveRun, rejectRun } from "../app/approveRun.js";
import { assessRun } from "../app/assessRun.js";
import { gateCommit } from "../app/gateCommit.js";
import { loadRun } from "../app/loadRun.js";
import { initRepo } from "../app/initRepo.js";
import { recordCommit } from "../app/recordCommit.js";
import { readVerdict, verifyRun } from "../app/verifyRun.js";
import { diffPatch } from "../git/diff.js";
import { readEvents } from "../store/eventLog.js";
import { findRepoRoot, rptDirOf } from "../store/paths.js";
import { readStartFailures, type StartFailure } from "../store/startFailures.js";
import { latestEntries, openRun, readIndex, type RunIndexEntry } from "../store/runIndex.js";
import { runHookCommand } from "./hook.js";
import type { OutputFormat } from "./format.js";
import { renderActiveRun, renderRun, renderRunList, renderTimeline, type PendingRun } from "./render.js";
import { renderRisk, renderVerdict } from "./renderRisk.js";

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
	process.stdout.write(`${renderActiveRun(await statusOf(root, entry), formatOf())}\n`);
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
		const root = await repoRoot();
		const runId = parseRunId(id);
		const { events, gapCount } = await readEvents(rptDirOf(root), runId);
		// Any surviving event is evidence, and showing evidence is what this command
		// is for. A run whose RunStarted was torn off by a crash is exactly the run a
		// user needs the timeline for, so it renders - with the gap warning above it -
		// rather than being answered for as if it had never existed. Only a run with
		// nothing readable at all falls through to be diagnosed.
		if (events.length === 0) throw new Error(await diagnosisMessage(root, runId));
		process.stdout.write(renderTimeline(events, gapCount, formatOf()));
	});

program.command("verify <id>").description("run or rerun verification").action(async (id: string) => {
	const root = await repoRoot();
	const verdict = await verifyRun(root, parseRunId(id));
	process.stdout.write(`${renderVerdict(verdict, formatOf())}\n`);
});

program.command("risk <id>").description("show the itemised risk assessment").action(async (id: string) => {
	const root = await repoRoot();
	const runId = parseRunId(id);
	const verdict = await readVerdict(root, runId);
	// Refused rather than silently verifying: verification runs a repository's
	// test command in a worktree, which is not something a read-only-looking
	// command should start on a user's behalf.
	if (verdict === null) throw new Error(`run ${runId} has not been verified yet - run "rpt verify ${runId}" first`);
	const { assessment } = await assessRun(root, await loadRunOrThrow(root, runId), verdict);
	process.stdout.write(`${renderRisk(assessment, formatOf())}\n`);
});

program.command("diff <id>").description("show the diff rpt observed").action(async (id: string) => {
	const root = await repoRoot();
	const run = await loadRunOrThrow(root, parseRunId(id));
	if (run.baseSha === null || run.endSha === null) {
		throw new Error(`run ${run.id} has no sealed end state, so there is no observed diff to show`);
	}
	process.stdout.write(`${await diffPatch(root, run.baseSha, run.endSha)}\n`);
});

program.command("approve <id>").description("record a human approval, terminal required").action(async (id: string) => {
	await decide(parseRunId(id), "approved");
});

program.command("reject <id>").description("record a human rejection, terminal required").action(async (id: string) => {
	await decide(parseRunId(id), "rejected");
});

// The exit code is the whole contract here: git runs this from pre-commit and
// reads nothing but the status. The explanation goes to stderr so a caller
// piping stdout still gets clean output.
program.command("gate").description("pre-commit gate").action(async () => {
	const outcome = await gateCommit(await repoRoot());
	if (!outcome.allowed) process.stderr.write(`${outcome.message}\n`);
	process.exitCode = outcome.exitCode;
});

// Always exits zero. It runs from post-commit, after the commit exists, where
// a non-zero status can undo nothing and only alarms a user who has no action
// available to them.
program
	.command("record")
	.description("attach the attestation note to the commit that just landed")
	.option("--quiet", "print nothing on success")
	.action(async (options: { quiet?: boolean }) => {
		try {
			const note = await recordCommit(await repoRoot());
			if (note !== null && options.quiet !== true) process.stdout.write(note);
		} catch (error) {
			process.stderr.write(`rpt: could not attach the attestation note: ${messageOf(error)}\n`);
		}
	});

async function decide(runId: RunId, decision: "approved" | "rejected"): Promise<void> {
	const root = await repoRoot();
	const actor = actorFromEnvironment();
	const approval = decision === "approved" ? await approveRun(root, runId, actor) : await rejectRun(root, runId, actor);
	process.stdout.write(
		formatOf() === "json"
			? `${JSON.stringify(approval, null, 2)}\n`
			: `run ${approval.runId} ${approval.decision} by ${approval.by} at ${approval.at}\n`,
	);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

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

// A stale, mistyped, or non-numeric run id is the single most likely mistake a user
// makes with this tool. Number("abc") and Number("1.5") are both non-integers, so
// this catches typos before they ever reach the domain fold below.
function parseRunId(raw: string): number {
	const id = Number(raw);
	if (!Number.isInteger(id)) throw new Error(`invalid run id "${raw}" - expected a whole number, try "rpt runs" to see valid ids`);
	return id;
}

// loadRun's projectRun throws when a run's log has no readable RunStarted at its
// head. That is true of an id never allocated, of a run still starting, and of a run
// whose start event a crash tore off - three different answers, so the failure is
// diagnosed rather than flattened into one blanket "no such run".
async function loadRunOrThrow(root: string, runId: number): Promise<AgentRun> {
	try {
		return await loadRun(root, runId);
	} catch (error) {
		if (!isUnprojectable(error)) throw error;
		throw new Error(await diagnosisMessage(root, runId));
	}
}

function isUnprojectable(error: unknown): boolean {
	return error instanceof Error && error.message.includes("does not begin with RunStarted");
}

// A run is in one of several states, and "absent" is only one of them: nothing
// anywhere claims it existed. A run that left evidence behind - surviving log
// lines, or a row in the index - is damaged, or starting, or failed to start, and
// calling any of those absent is the tool denying evidence it is holding. That is
// the one thing it exists not to do. Only reached once a projection has failed.
type RunDiagnosis =
	| { kind: "absent" }
	| { kind: "damaged"; gapCount: number }
	| { kind: "failedToStart"; reason: string }
	| { kind: "starting" };

async function diagnoseRun(root: string, runId: number): Promise<RunDiagnosis> {
	const rptDir = rptDirOf(root);
	const { gapCount } = await readEvents(rptDir, runId);
	if (gapCount > 0) return { kind: "damaged", gapCount };
	const row = latestEntries((await readIndex(rptDir)).entries).find((entry) => entry.id === runId);
	if (row === undefined) return { kind: "absent" };
	// A row that has already been sealed has an empty log it should not have. That
	// is damage, not a run still on its way up.
	if (row.state !== "RUNNING") return { kind: "damaged", gapCount: 0 };
	return startingOrFailed(rptDir, row);
}

// The only thing separating a run still starting from a run that failed to start is
// whether the failure was recorded, so the start-failure log is what answers it.
// The index row is reserved before the git snapshot, and on a large repository that
// snapshot takes seconds - a window every normal session passes through, and one
// that must never be reported as a failure.
async function startingOrFailed(rptDir: string, row: RunIndexEntry): Promise<RunDiagnosis> {
	const failure = latestFailureSince(await readStartFailures(rptDir), row.startedAt);
	return failure === null ? { kind: "starting" } : { kind: "failedToStart", reason: failure.reason };
}

function latestFailureSince(failures: readonly StartFailure[], startedAt: string): StartFailure | null {
	const since = failures.filter((failure) => failure.ts >= startedAt);
	return since[since.length - 1] ?? null;
}

async function diagnosisMessage(root: string, runId: number): Promise<string> {
	return messageFor(runId, await diagnoseRun(root, runId));
}

function messageFor(runId: number, diagnosis: RunDiagnosis): string {
	switch (diagnosis.kind) {
		case "absent":
			return `no run ${runId} found here - try "rpt runs" to see valid ids`;
		case "failedToStart":
			return `run ${runId} failed to start and recorded nothing: ${diagnosis.reason} - see "rpt runs"`;
		case "starting":
			return `run ${runId} is still starting - it has an id but has not recorded its first event yet`;
		case "damaged":
			return diagnosis.gapCount > 0
				? `run ${runId} is damaged: ${diagnosis.gapCount} unreadable line(s) in its event log and no readable RunStarted - it exists but cannot be projected, try "rpt events ${runId}" to see what survived`
				: `run ${runId} is damaged: the run index lists it but its event log recorded nothing`;
	}
}

// A run that is starting is a normal, transient state, not a failure, so status
// renders it and exits zero. Every other unprojectable state is reported as the
// problem it is - answering "no active run" for any of them would be the silence
// this tool exists to remove.
async function statusOf(root: string, entry: RunIndexEntry | null): Promise<AgentRun | PendingRun | null> {
	if (entry === null) return null;
	try {
		return await loadRun(root, entry.id);
	} catch (error) {
		if (!isUnprojectable(error)) throw error;
		const diagnosis = await diagnoseRun(root, entry.id);
		if (diagnosis.kind === "starting") return { pending: "starting", id: entry.id };
		throw new Error(messageFor(entry.id, diagnosis));
	}
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
	const message = messageOf(error);
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
