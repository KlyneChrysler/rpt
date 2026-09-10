// Maps each file in an lcov report to the set of lines the coverage run
// actually executed. A DA record with a zero hit count is deliberately
// excluded here rather than folded into "not covered" by the caller: keeping
// only executed lines in this map is what lets a caller tell "measured, zero
// hits" (line present in the report but absent from this set) apart from
// "never measured at all" (the file itself absent from this map).
export function parseLcov(body: string): Map<string, Set<number>> {
	const covered = new Map<string, Set<number>>();
	let file: string | null = null;
	for (const line of body.split("\n")) {
		if (line.startsWith("SF:")) {
			file = line.slice(3).trim();
			covered.set(file, new Set());
			continue;
		}
		if (file === null || !line.startsWith("DA:")) continue;
		const [number = "0", hits = "0"] = line.slice(3).split(",");
		if (Number(hits) > 0) covered.get(file)?.add(Number(number));
	}
	return covered;
}
