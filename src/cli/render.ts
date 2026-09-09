import type { AgentEvent } from "../domain/events.js";
import type { AgentRun } from "../domain/run.js";
import type { IndexReadResult } from "../store/runIndex.js";
import type { StartFailure } from "../store/startFailures.js";
import { formatDuration, formatOffset, type OutputFormat } from "./format.js";

export function renderRun(run: AgentRun, format: OutputFormat): string {
	if (format === "json") return JSON.stringify(run, null, 2);
	if (format === "agent") return agentLines(run).join("\n");
	return textLines(run).join("\n");
}

// No active run is a normal, common outcome (right after `rpt init`, in CI, between
// agent sessions) - not an error - so it goes through the same format switch as a
// real run rather than a bare stdout string that would break json piping.
export function renderActiveRun(run: AgentRun | null, format: OutputFormat): string {
	if (run !== null) return renderRun(run, format);
	if (format === "json") return JSON.stringify({ active: null }, null, 2);
	return "no active run";
}

// Everything that makes the list less than the whole truth travels with it:
// corruptLines because a shorter-than-expected list and a damaged index look
// identical otherwise, startFailures because a session that never opened a run
// leaves nothing in the list at all. The reader has to be told which of the three
// they are looking at, in every format.
export type RunListView = IndexReadResult & { startFailures: readonly StartFailure[] };

export function renderRunList(view: RunListView, format: OutputFormat): string {
	if (format === "json") {
		return JSON.stringify({ runs: view.entries, corruptLines: view.corruptLines, startFailures: view.startFailures }, null, 2);
	}
	if (format === "agent") return agentRunListLines(view).join("\n");
	return [
		...corruptWarning(view.corruptLines),
		...startFailureWarning(view.startFailures),
		...view.entries.map(runListLine),
	].join("\n");
}

// gapCount travels with the events for the same reason corruptLines travels with
// the run list: a timeline with lines missing and a timeline that is complete look
// identical once the unreadable lines have been dropped. The run summary already
// warns about a gapped run, and the timeline is where a user goes to find out what
// is missing - it is the last surface that should read clean.
export function renderTimeline(events: AgentEvent[], gapCount: number, format: OutputFormat): string {
	if (format === "json") return JSON.stringify({ events, gapCount }, null, 2);
	return `${[...gapWarning(gapCount), ...timelineLines(events)].join("\n")}\n`;
}

function timelineLines(events: AgentEvent[]): string[] {
	const start = events[0]?.ts ?? new Date().toISOString();
	return events.map((event) => timelineLine(start, event));
}

function gapWarning(gapCount: number): string[] {
	return gapCount > 0
		? [`WARNING: ${gapCount} unreadable line(s) in this run's event log - the timeline below has gaps`, ""]
		: [];
}

function runListLine(entry: IndexReadResult["entries"][number]): string {
	return `${String(entry.id).padStart(5)}  ${entry.state.padEnd(18)}  ${entry.task}`;
}

function corruptWarning(corruptLines: number): string[] {
	return corruptLines > 0 ? [`WARNING: ${corruptLines} corrupt line(s) in the run index, list may be incomplete`, ""] : [];
}

function startFailureWarning(failures: readonly StartFailure[]): string[] {
	const latest = failures[failures.length - 1];
	if (latest === undefined) return [];
	return [
		`WARNING: ${failures.length} session(s) failed to start and recorded nothing at all`,
		`         most recently: ${latest.reason}`,
		"",
	];
}

// Same reasoning as agentLines: the agent format is injected into context on every
// invocation, so a run history that has grown to hundreds of entries must not grow
// the output past a fixed cap, just like a single run's file count must not.
const AGENT_RUN_LIST_CAP = 10;

function agentRunListLines(view: RunListView): string[] {
	const shown = view.entries.slice(0, AGENT_RUN_LIST_CAP);
	const omitted = view.entries.length - shown.length;
	return [
		...(view.corruptLines > 0 ? [`WARNING: ${view.corruptLines} corrupt line(s) in the run index`] : []),
		...(view.startFailures.length > 0
			? [`WARNING: ${view.startFailures.length} session(s) failed to start and recorded nothing`]
			: []),
		...shown.map(runListLine),
		...(omitted > 0 ? [`... ${omitted} more run(s) omitted, run "rpt runs" for the full list`] : []),
	];
}

function textLines(run: AgentRun): string[] {
	return [
		`RUN ${run.id}  ${run.state}`,
		"",
		`  ${run.task}`,
		"",
		`  duration   ${formatDuration(run.startedAt, run.endedAt)}`,
		`  files      ${run.claims.mutatedPaths.length} claimed`,
		`  commands   ${run.claims.commands.length}`,
		`  messages   ${run.usage.length}`,
		...(run.hasGaps ? ["", "  WARNING: event log has gaps, this run cannot be verified"] : []),
	];
}

function agentLines(run: AgentRun): string[] {
	return [
		`RUN ${run.id} ${run.state} | ${run.task}`,
		`files ${run.claims.mutatedPaths.length} | cmds ${run.claims.commands.length} | ${formatDuration(run.startedAt, run.endedAt)}${run.hasGaps ? " | GAPS: not verifiable" : ""}`,
	];
}

function timelineLine(start: string, event: AgentEvent): string {
	return `${formatOffset(start, event.ts)}  ${event.kind.padEnd(20)} ${summarize(event)}`;
}

function summarize(event: AgentEvent): string {
	const payload = event.payload;
	const interesting = payload.path ?? payload.command ?? payload.tool ?? payload.model ?? "";
	return String(interesting);
}
