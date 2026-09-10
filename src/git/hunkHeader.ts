export type HunkHeader = { newStart: number; newCount: number };

// "@@ -oldStart[,oldLines] +newStart[,newLines] @@" - the count defaults to 1
// when omitted (a single-line hunk). Shared so the fiddly bit - the regex and
// the "count defaults to 1" rule - exists in exactly one place, even though
// its two callers use the result differently: scanSecrets steps through a
// hunk's content one line at a time and only needs the starting point, while
// changedLines needs the full numeric range a hunk covers without walking it.
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function parseHunkHeader(line: string): HunkHeader | null {
	const match = HUNK_HEADER.exec(line);
	if (match === null) return null;
	const newStart = Number(match[1]);
	const newCount = match[2] === undefined ? 1 : Number(match[2]);
	return { newStart, newCount };
}
