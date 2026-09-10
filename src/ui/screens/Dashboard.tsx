import { Box, Text } from "ink";
import React from "react";
import type { DashboardModel, RunSummary } from "../../app/readModel.js";
import { colorForLevel, colorForState } from "../theme.js";

const MARKER_WIDTH = 2;
const ID_WIDTH = 6;
const STATE_WIDTH = 18;
const LEVEL_WIDTH = 12;
const COST_WIDTH = 12;

// Column widths are Box widths, never padEnd inside a Text. Ink trims trailing
// whitespace when it measures a Text node, so a padded string arrives at the
// terminal shorter than it was written and by an amount that varies per row -
// which is exactly how a table of runs comes out with none of its columns
// lining up. Letting Ink reserve the width is the only way the padding
// survives to the screen.
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
			<Header />
			{model.runs.map((run, index) => (
				<Row key={run.id} run={run} selected={index === selectedIndex} />
			))}
		</Box>
	);
}

function Cell({ width, children }: { width: number; children: React.ReactNode }): React.ReactElement {
	return (
		<Box width={width} flexShrink={0}>
			{children}
		</Box>
	);
}

function Header(): React.ReactElement {
	return (
		<Box>
			<Cell width={MARKER_WIDTH}>
				<Text> </Text>
			</Cell>
			<Cell width={ID_WIDTH}>
				<Text dimColor>RUN</Text>
			</Cell>
			<Cell width={STATE_WIDTH}>
				<Text dimColor>STATE</Text>
			</Cell>
			<Cell width={LEVEL_WIDTH}>
				<Text dimColor>RISK</Text>
			</Cell>
			<Cell width={COST_WIDTH}>
				<Text dimColor>COST</Text>
			</Cell>
			<Text dimColor>TASK</Text>
		</Box>
	);
}

function Row({ run, selected }: { run: RunSummary; selected: boolean }): React.ReactElement {
	return (
		<Box>
			<Cell width={MARKER_WIDTH}>
				<Text color="cyan">{selected ? ">" : " "}</Text>
			</Cell>
			<Cell width={ID_WIDTH}>
				<Text>{String(run.id)}</Text>
			</Cell>
			<Cell width={STATE_WIDTH}>
				<Text color={colorForState(run.state)}>{run.state}</Text>
			</Cell>
			<Cell width={LEVEL_WIDTH}>
				<Text color={colorForLevel(run.riskLevel)}>{riskText(run)}</Text>
			</Cell>
			<Cell width={COST_WIDTH}>
				<Text>{costText(run.costUsd)}</Text>
			</Cell>
			{/* Truncated rather than wrapped: a task is a free-text prompt line and
			    a wrapped one pushes every row below it out of alignment, which
			    costs more than the tail of a sentence is worth. */}
			<Box flexGrow={1}>
				<Text wrap="truncate-end">{taskText(run)}</Text>
			</Box>
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
