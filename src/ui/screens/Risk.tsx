import { Box, Text } from "ink";
import React from "react";
import type { RunDetailModel } from "../../app/readModel.js";
import { Bar } from "../components/Bar.js";
import { colorForLevel } from "../theme.js";

const BAR_WIDTH = 30;
const LABEL_WIDTH = 50;
const MAX_SCORE = 100;

export function Risk({ model }: { model: RunDetailModel }): React.ReactElement {
	if (model.risk === null) {
		return (
			<Box flexDirection="column">
				<Text bold>RISK SCORE</Text>
				<Text dimColor>this run is not verified, so there is nothing to score</Text>
			</Box>
		);
	}
	const risk = model.risk;
	return (
		<Box flexDirection="column">
			<Text bold>{`RISK SCORE: ${risk.score} / ${MAX_SCORE}`}</Text>
			<Text> </Text>
			<Bar value={risk.score} max={MAX_SCORE} width={BAR_WIDTH} color={colorForLevel(risk.level)} />
			<Text> </Text>
			{risk.contributions.map((entry) => (
				<Box key={entry.id}>
					<Text>{entry.label.padEnd(LABEL_WIDTH)}</Text>
					<Text color={entry.points >= 0 ? "red" : "green"}>{signed(entry.points).padStart(5)}</Text>
				</Box>
			))}
			<Text> </Text>
			<Box>
				<Text>{"LEVEL: "}</Text>
				<Text color={colorForLevel(risk.level)} bold>
					{risk.level}
				</Text>
			</Box>
			<Text dimColor>{consequenceOf(risk.level)}</Text>
		</Box>
	);
}

// The score is only useful if a reader knows what it costs them, so every band
// states its consequence rather than leaving the thresholds to be looked up.
function consequenceOf(level: string): string {
	if (level === "CRITICAL") return "commit blocked - approval required but unavailable at this level";
	if (level === "HIGH") return "human approval required before this run can be committed";
	return level === "MEDIUM" ? "review recommended" : "cleared automatically";
}

function signed(points: number): string {
	return points >= 0 ? `+${points}` : String(points);
}
