import { Box, Text } from "ink";
import React from "react";
import type { DashboardModel, RunSummary } from "../../app/readModel.js";
import { colorForLevel, colorForState } from "../theme.js";

const ID_WIDTH = 6;
const STATE_WIDTH = 18;
const LEVEL_WIDTH = 12;
const COST_WIDTH = 10;

export function Dashboard({ model, selectedIndex }: { model: DashboardModel; selectedIndex: number }): React.ReactElement {
	return (
		<Box flexDirection="column">
			<Box>
				<Text bold>rpt</Text>
				<Text dimColor>{"  Agent Verification Engine"}</Text>
			</Box>
			<Text> </Text>
			{model.runs.length === 0 ? <EmptyState /> : <RunRows model={model} selectedIndex={selectedIndex} />}
		</Box>
	);
}

function RunRows({ model, selectedIndex }: { model: DashboardModel; selectedIndex: number }): React.ReactElement {
	return (
		<Box flexDirection="column">
			<Text dimColor>{header()}</Text>
			{model.runs.map((run, index) => (
				<Row key={run.id} run={run} selected={index === selectedIndex} />
			))}
		</Box>
	);
}

function Row({ run, selected }: { run: RunSummary; selected: boolean }): React.ReactElement {
	return (
		<Box>
			<Text color={selected ? "cyan" : "gray"}>{selected ? "> " : "  "}</Text>
			<Text>{String(run.id).padEnd(ID_WIDTH)}</Text>
			<Text color={colorForState(run.state)}>{run.state.padEnd(STATE_WIDTH)}</Text>
			<Text color={colorForLevel(run.riskLevel)}>{riskText(run).padEnd(LEVEL_WIDTH)}</Text>
			<Text>{costText(run.costUsd).padEnd(COST_WIDTH)}</Text>
			<Text>{taskText(run)}</Text>
		</Box>
	);
}

function EmptyState(): React.ReactElement {
	return (
		<Box flexDirection="column">
			<Text>no runs recorded yet</Text>
			<Text> </Text>
			<Text dimColor>run "rpt init" in a repository, then start an agent session</Text>
		</Box>
	);
}

function header(): string {
	return `  ${"RUN".padEnd(ID_WIDTH)}${"STATE".padEnd(STATE_WIDTH)}${"RISK".padEnd(LEVEL_WIDTH)}${"COST".padEnd(COST_WIDTH)}TASK`;
}

// A run with no assessment reads as a dash, never as a zero: an unscored run
// and a run scored zero are different facts and must not share a rendering.
function riskText(run: RunSummary): string {
	return run.riskLevel === null ? "-" : `${run.riskScore} ${run.riskLevel}`;
}

function costText(usd: number | null): string {
	return usd === null ? "unknown" : `${usd.toFixed(2)} USD`;
}

// A run whose log could not be projected says so in the one column a reader
// scans for meaning, rather than showing an empty task and looking ordinary.
function taskText(run: RunSummary): string {
	if (run.unprojectable !== null) return "(unreadable: this run cannot be projected from its log)";
	return run.task === "" ? "(no task recorded)" : run.task;
}
