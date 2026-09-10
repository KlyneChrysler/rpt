import { Box, Text } from "ink";
import React from "react";
import type { RunDetailModel } from "../../app/readModel.js";
import { Panel } from "../components/Panel.js";
import { StatTiles, type Tile } from "../components/StatTiles.js";

const PERCENT = 100;
const COVERAGE_DECIMALS = 0;

// What rpt observed by running the project's own tests, as opposed to what the
// agent said about them. The distinction is the reason this screen exists: an
// agent reporting "184 tests pass" and rpt having watched 184 tests pass are
// different facts, and only one of them is on this screen.
export function Tests({ model }: { model: RunDetailModel }): React.ReactElement {
	const tests = factsOf(model, "tests");
	const quality = factsOf(model, "test-quality");
	return (
		<Box flexDirection="column">
			<Text bold>{`TESTS  run ${model.run.id}`}</Text>
			<Text> </Text>
			{model.verdict === null ? <NotVerified /> : null}
			<StatTiles tiles={tilesOf(tests, quality)} />
			<Text> </Text>
			<Panel title="OBSERVED BY">
				<Result model={model} id="tests" />
				<Result model={model} id="test-quality" />
			</Panel>
			<Text> </Text>
			<Panel title="CLAIMED BY THE AGENT">
				{model.run.claims.commands.length === 0 ? (
					<Text dimColor>the agent ran no commands rpt saw</Text>
				) : (
					model.run.claims.commands.slice(0, MAX_COMMANDS).map((command, index) => (
						<Text key={index} dimColor>
							{command}
						</Text>
					))
				)}
			</Panel>
		</Box>
	);
}

const MAX_COMMANDS = 10;

function tilesOf(tests: Record<string, unknown>, quality: Record<string, unknown>): Tile[] {
	return [
		{ label: "Passed", value: countText(tests.passed), color: "green" },
		{ label: "Failed", value: countText(tests.failed), color: failedColor(tests.failed) },
		{ label: "Command", value: commandText(tests.command) },
		{ label: "Change coverage", value: coverageText(quality.changeCoverage) },
	];
}

function Result({ model, id }: { model: RunDetailModel; id: string }): React.ReactElement {
	const result = model.verdict?.results.find((entry) => entry.id === id);
	if (result === undefined) {
		return (
			<Box>
				<Text>{id.padEnd(16)}</Text>
				<Text dimColor>not run</Text>
			</Box>
		);
	}
	return (
		<Box>
			<Text>{result.id.padEnd(16)}</Text>
			<Text color={statusColor(result.status)}>{result.status.padEnd(10)}</Text>
			<Text dimColor>{result.reason ?? ""}</Text>
		</Box>
	);
}

function NotVerified(): React.ReactElement {
	return (
		<Box marginBottom={1}>
			<Text color="yellow">{'this run is not verified - run "rpt verify" to find out what the tests actually did'}</Text>
		</Box>
	);
}

function statusColor(status: string): string {
	if (status === "passed") return "green";
	return status === "failed" ? "red" : "yellow";
}

// A count rpt could not parse out of the reporter reads unknown, never zero. A
// suite with no failures and a reporter rpt could not read produce the same
// number otherwise, and only one of them is evidence of anything.
function countText(value: unknown): string {
	return typeof value === "number" && Number.isFinite(value) ? String(value) : "unknown";
}

function failedColor(value: unknown): string {
	return typeof value === "number" && value > 0 ? "red" : "green";
}

function commandText(value: unknown): string {
	return typeof value === "string" && value !== "" ? value : "none resolved";
}

function coverageText(value: unknown): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
	return `${(value * PERCENT).toFixed(COVERAGE_DECIMALS)}%`;
}

function factsOf(model: RunDetailModel, id: string): Record<string, unknown> {
	return model.verdict?.results.find((result) => result.id === id)?.facts ?? {};
}
