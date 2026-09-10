import { Text } from "ink";
import React from "react";

const FILLED = "#";
const EMPTY = ".";

// ASCII rather than block-drawing characters: the bar is the one element whose
// width has to be exact for the score to read correctly, and a terminal or
// font that renders U+2588 at a different advance width silently misreports it.
export function Bar({ value, max, width, color }: { value: number; max: number; width: number; color?: string }): React.ReactElement {
	const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
	// Spread rather than passed directly: under exactOptionalPropertyTypes an
	// explicit undefined is not the same as an absent prop, and Ink's Text takes
	// the terminal's own default only when the prop is absent.
	return <Text {...(color === undefined ? {} : { color })}>{`${FILLED.repeat(filled)}${EMPTY.repeat(width - filled)}`}</Text>;
}
