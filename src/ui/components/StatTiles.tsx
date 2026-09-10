import { Box, Text } from "ink";
import React from "react";

export type Tile = { label: string; value: string; color?: string };

export function StatTiles({ tiles }: { tiles: readonly Tile[] }): React.ReactElement {
	return (
		<Box flexDirection="row">
			{tiles.map((tile) => (
				<Box key={tile.label} flexDirection="column" marginRight={3}>
					<Text dimColor>{tile.label}</Text>
					<Text {...(tile.color === undefined ? {} : { color: tile.color })} bold>
						{tile.value}
					</Text>
				</Box>
			))}
		</Box>
	);
}
