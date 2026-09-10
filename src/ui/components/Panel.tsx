import { Box, Text } from "ink";
import React from "react";

export function Panel({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
	return (
		<Box flexDirection="column" borderStyle="round" paddingX={1}>
			<Text bold>{title}</Text>
			{children}
		</Box>
	);
}
