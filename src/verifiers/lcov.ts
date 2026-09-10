type LcovFileData = { executed: Set<number>; recorded: Set<number> };

// A DA record with a zero hit count is still a recorded line - the coverage
// tool measured it and found nothing ran. A line absent from this file's
// records entirely (a blank line, an import, a type-only line - anything the
// tool never instruments) is a different fact altogether. One pass over the
// report builds both sets per file so `parseLcov` and `parseLcovRecordedLines`
// never have to re-walk the same SF:/DA: parsing to answer their two
// different questions.
function parseLcovDetailed(body: string): Map<string, LcovFileData> {
	const files = new Map<string, LcovFileData>();
	let file: string | null = null;
	for (const line of body.split("\n")) {
		if (line.startsWith("SF:")) {
			file = line.slice(3).trim();
			files.set(file, { executed: new Set(), recorded: new Set() });
			continue;
		}
		if (file === null || !line.startsWith("DA:")) continue;
		const [number = "0", hits = "0"] = line.slice(3).split(",");
		const data = files.get(file);
		if (data === undefined) continue;
		const lineNumber = Number(number);
		data.recorded.add(lineNumber);
		if (Number(hits) > 0) data.executed.add(lineNumber);
	}
	return files;
}

// Maps each file in an lcov report to the set of lines the coverage run
// actually executed. A DA record with a zero hit count is deliberately
// excluded here rather than folded into "not covered" by the caller: keeping
// only executed lines in this map is what lets a caller tell "measured, zero
// hits" (line present in parseLcovRecordedLines but absent from this set)
// apart from "never measured at all" (the file itself absent from this map).
export function parseLcov(body: string): Map<string, Set<number>> {
	return mapValues(parseLcovDetailed(body), (data) => data.executed);
}

// Maps each file to every line the coverage tool recorded a result for at
// all, executed or not - i.e. every line it actually instrumented. A changed
// line absent from this set was never instrumented, so it cannot honestly be
// judged either covered or uncovered; only a line present here (in a file
// present here) is a fact this report can speak to.
export function parseLcovRecordedLines(body: string): Map<string, Set<number>> {
	return mapValues(parseLcovDetailed(body), (data) => data.recorded);
}

function mapValues<V>(files: Map<string, LcovFileData>, select: (data: LcovFileData) => V): Map<string, V> {
	return new Map([...files].map(([file, data]) => [file, select(data)]));
}
