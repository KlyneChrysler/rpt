import { Box, Text } from "ink";
import React from "react";
import type { RunDetailModel } from "../../app/readModel.js";
import { colorForLevel } from "../theme.js";

export type ApprovalStatus =
	| { kind: "prompt" }
	| { kind: "refused"; message: string }
	| { kind: "working" }
	| { kind: "done"; summary: string };

// The console's approval screen states the same three facts the typed
// confirmation will repeat back - the run, the verdict and the risk level -
// so a person is deciding on what rpt observed rather than on what they
// remember asking the agent to do.
export function Approve({ model, status }: { model: RunDetailModel; status: ApprovalStatus }): React.ReactElement {
	return (
		<Box flexDirection="column">
			<Text bold>{`APPROVE RUN ${model.run.id}`}</Text>
			<Text>{model.run.task === "" ? "(no task recorded)" : model.run.task}</Text>
			<Text> </Text>
			<Box>
				<Text>{`verdict ${model.verdict?.name ?? "not verified"}   risk `}</Text>
				<Text color={colorForLevel(model.risk?.level ?? null)}>
					{model.risk === null ? "not assessed" : `${model.risk.score} ${model.risk.level}`}
				</Text>
			</Box>
			{model.verdict !== null && model.verdict.name !== "VERIFIED" ? (
				<Text color="yellow">{`approving this run is an override: rpt could not verify it (${model.verdict.name})`}</Text>
			) : null}
			<Text> </Text>
			<Body status={status} />
		</Box>
	);
}

function Body({ status }: { status: ApprovalStatus }): React.ReactElement {
	if (status.kind === "refused") {
		return (
			<Box flexDirection="column">
				<Text color="red">{status.message}</Text>
				<Text dimColor>the console offers no way around this</Text>
			</Box>
		);
	}
	if (status.kind === "working") return <Text dimColor>waiting for your typed confirmation at the terminal...</Text>;
	if (status.kind === "done") return <Text color="green">{status.summary}</Text>;
	return (
		<Box flexDirection="column">
			<Text>press y to approve, n to reject, escape to go back</Text>
			<Text dimColor>either choice then asks you to type a confirmation phrase at this terminal</Text>
		</Box>
	);
}
