import { Box, Text } from "ink";
import React from "react";
import type { RunDetailModel } from "../../app/readModel.js";
import { formatOffset } from "../../domain/duration.js";

const KIND_WIDTH = 22;
const MAX_ROWS = 400;

export function Events({ model }: { model: RunDetailModel }): React.ReactElement {
	const shown = model.events.slice(0, MAX_ROWS);
	const hidden = model.events.length - shown.length;
	const start = model.events[0]?.ts ?? model.run.startedAt;
	return (
		<Box flexDirection="column">
			<Text bold>{`EVENTS  run ${model.run.id}`}</Text>
			<Text> </Text>
			{shown.length === 0 ? <Text dimColor>no events recorded for this run</Text> : null}
			{shown.map((event) => (
				<Box key={event.seq}>
					<Text dimColor>{`${formatOffset(start, event.ts)}  `}</Text>
					<Text>{event.kind.padEnd(KIND_WIDTH)}</Text>
					<Text dimColor>{detailOf(event.payload)}</Text>
				</Box>
			))}
			{hidden > 0 ? <Text dimColor>{`... ${hidden} more event(s) not shown`}</Text> : null}
		</Box>
	);
}

function detailOf(payload: Record<string, unknown>): string {
	for (const key of ["path", "command", "id", "model", "level", "by"]) {
		const value = payload[key];
		if (typeof value === "string" && value !== "") return value;
	}
	return "";
}
