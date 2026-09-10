import { Box, Text } from "ink";
import React from "react";
import type { RunDetailModel } from "../../app/readModel.js";
import { formatDuration } from "../../domain/duration.js";
import { Panel } from "../components/Panel.js";
import { StatTiles, type Tile } from "../components/StatTiles.js";
import { colorForLevel, colorForState } from "../theme.js";

export function RunDetail({ model }: { model: RunDetailModel }): React.ReactElement {
	const { run } = model;
	return (
		<Box flexDirection="column">
			<Box>
				<Text bold>{`RUN ${run.id}  `}</Text>
				<Text color={colorForState(model.verdict?.name ?? run.state)}>{model.verdict?.name ?? "not verified"}</Text>
			</Box>
			<Text>{run.task === "" ? "(no task recorded)" : run.task}</Text>
			<Text> </Text>
			<StatTiles tiles={tilesOf(model)} />
			<Text> </Text>
			<Verifiers model={model} />
			{run.hasGaps ? <GapWarning /> : null}
		</Box>
	);
}

function tilesOf(model: RunDetailModel): Tile[] {
	const tests = testFactsOf(model);
	return [
		{ label: "Duration", value: formatDuration(model.run.startedAt, model.run.endedAt) },
		{ label: "Cost", value: model.costUsd === null ? "unknown" : `${model.costUsd.toFixed(2)} USD` },
		{ label: "Files", value: String(model.run.claims.mutatedPaths.length) },
		{ label: "Tests", value: `${countText(tests.passed)} passed / ${countText(tests.failed)} failed` },
		{
			label: "Risk",
			value: model.risk === null ? "not verified" : `${model.risk.score} ${model.risk.level}`,
			color: colorForLevel(model.risk?.level ?? null),
		},
	];
}

function Verifiers({ model }: { model: RunDetailModel }): React.ReactElement {
	if (model.verdict === null) {
		return (
			<Panel title="CHECKS">
				<Text dimColor>this run is not verified - run "rpt verify" to produce a verdict</Text>
			</Panel>
		);
	}
	return (
		<Panel title="CHECKS">
			{model.verdict.results.map((result) => (
				<Box key={result.id}>
					<Text>{result.id.padEnd(16)}</Text>
					<Text color={statusColor(result.status)}>{result.status.padEnd(10)}</Text>
					<Text dimColor>{result.reason ?? ""}</Text>
				</Box>
			))}
		</Panel>
	);
}

function GapWarning(): React.ReactElement {
	return (
		<Box marginTop={1}>
			<Text color="yellow" bold>
				{"WARNING: this run's event log has gaps, so it can never be verified"}
			</Text>
		</Box>
	);
}

// A skipped check is never coloured like a pass. The whole verdict turns on
// the difference between "rpt checked and it was fine" and "rpt could not
// check", and colour is the first thing a reader takes in.
function statusColor(status: string): string {
	if (status === "passed") return "green";
	return status === "failed" ? "red" : "yellow";
}

function testFactsOf(model: RunDetailModel): Record<string, unknown> {
	return model.verdict?.results.find((result) => result.id === "tests")?.facts ?? {};
}

function countText(value: unknown): string {
	return typeof value === "number" && Number.isFinite(value) ? String(value) : "unknown";
}
