import { git } from "./exec.js";

export type DiffStatus = "A" | "M" | "D" | "R";
// oldPath is set only for a rename (status "R"): git reports a rename under its
// new path alone, so callers that need the origin path back need it carried here
// rather than reconstructing it from the raw name-status line themselves.
export type DiffEntry = { path: string; status: DiffStatus; oldPath?: string };

export async function diffNameStatus(
	repo: string,
	from: string,
	to: string,
): Promise<DiffEntry[]> {
	const output = await git(repo, ["diff", "--name-status", "-M", from, to]);
	if (output === "") return [];
	return output.split("\n").map(toEntry);
}

export async function diffStat(
	repo: string,
	from: string,
	to: string,
): Promise<{ added: number; removed: number }> {
	const output = await git(repo, ["diff", "--numstat", from, to]);
	if (output === "") return { added: 0, removed: 0 };
	return output.split("\n").reduce(accumulate, { added: 0, removed: 0 });
}

export async function diffPatch(repo: string, from: string, to: string): Promise<string> {
	return git(repo, ["diff", "--unified=3", from, to]);
}

function toEntry(line: string): DiffEntry {
	const [rawStatus = "M", path = "", renamed] = line.split("\t");
	const status = rawStatus.charAt(0) as DiffStatus;
	if (status === "R") return { path: renamed ?? path, status, oldPath: path };
	return { path, status };
}

function accumulate(
	totals: { added: number; removed: number },
	line: string,
): { added: number; removed: number } {
	const [added = "0", removed = "0"] = line.split("\t");
	return {
		added: totals.added + numberOf(added),
		removed: totals.removed + numberOf(removed),
	};
}

function numberOf(field: string): number {
	return field === "-" ? 0 : Number(field);
}
