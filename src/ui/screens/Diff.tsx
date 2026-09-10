import { Box, Text } from "ink";
import React from "react";

const MAX_LINES = 400;

// Truncated rather than streamed: a single run can change thousands of lines,
// and a terminal asked to lay out all of them stops responding to the key that
// would let a user leave. The footer states how much is hidden, because a diff
// silently cut short is a diff a reader would draw the wrong conclusion from.
export function Diff({ patch }: { patch: string }): React.ReactElement {
	const lines = patch === "" ? [] : patch.split("\n");
	const shown = lines.slice(0, MAX_LINES);
	const hidden = lines.length - shown.length;
	return (
		<Box flexDirection="column">
			<Text bold>DIFF</Text>
			<Text> </Text>
			{shown.length === 0 ? <Text dimColor>no observed changes</Text> : null}
			{shown.map((line, index) => (
				<Text key={index} color={colorForLine(line)}>
					{line === "" ? " " : line}
				</Text>
			))}
			{hidden > 0 ? <Text dimColor>{`... ${hidden} more line(s) not shown`}</Text> : null}
		</Box>
	);
}

function colorForLine(line: string): string {
	if (line.startsWith("+++") || line.startsWith("---")) return "cyan";
	if (line.startsWith("+")) return "green";
	if (line.startsWith("-")) return "red";
	return line.startsWith("@@") ? "magenta" : "white";
}
