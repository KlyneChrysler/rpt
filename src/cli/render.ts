import type { AgentEvent } from "../domain/events.js";
import type { AgentRun } from "../domain/run.js";
import type { IndexReadResult } from "../store/runIndex.js";
import { formatDuration, formatOffset, type OutputFormat } from "./format.js";

export function renderRun(run: AgentRun, format: OutputFormat): string {
	if (format === "json") return JSON.stringify(run, null, 2);
	if (format === "agent") return agentLines(run).join("\n");
	return textLines(run).join("\n");
}

// corruptLines travels alongside the entries because a shorter-than-expected
// list and a damaged index look identical otherwise - the reader must be told
// which one they're looking at, in every format.
export function renderRunList(result: IndexReadResult, format: OutputFormat): string {
	if (format === "json") return JSON.stringify({ runs: result.entries, corruptLines: result.corruptLines }, null, 2);
	return [...corruptWarning(result.corruptLines), ...result.entries.map(runListLine)].join("\n");
}

export function renderTimeline(events: AgentEvent[], format: OutputFormat): string {
	if (format === "json") return JSON.stringify(events, null, 2);
	const start = events[0]?.ts ?? new Date().toISOString();
	return `${events.map((event) => timelineLine(start, event)).join("\n")}\n`;
}

function runListLine(entry: IndexReadResult["entries"][number]): string {
	return `${String(entry.id).padStart(5)}  ${entry.state.padEnd(18)}  ${entry.task}`;
}

function corruptWarning(corruptLines: number): string[] {
	return corruptLines > 0 ? [`WARNING: ${corruptLines} corrupt line(s) in the run index, list may be incomplete`, ""] : [];
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
