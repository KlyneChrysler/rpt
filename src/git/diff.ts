import { git } from "./exec.js";

export type DiffStatus = "A" | "M" | "D" | "R";
// oldPath is set only for a rename (status "R"): git reports a rename under its
// new path alone, so callers that need the origin path back need it carried here
// rather than reconstructing it from the raw name-status line themselves.
export type DiffEntry = { path: string; status: DiffStatus; oldPath?: string };

// -z is requested on both of these, not just to stop git quoting/octal-escaping
// non-ASCII paths (an accented filename would otherwise come back as a quoted,
// backslash-escaped string that no longer matches the agent's claim), but
// because it is the only format where a rename record is unambiguous: with -z,
// each field - status, then one path (two fields) or old-path and new-path
// (three fields) - is NUL-terminated, so record boundaries never depend on
// guessing from tab or arrow ("=>") placement the way the human-readable format
// does. Disabling quoting alone would fix the accented case and nothing else.
export async function diffNameStatus(
	repo: string,
	from: string,
	to: string,
): Promise<DiffEntry[]> {
	const fields = await nulDelimitedFields(repo, ["diff", "--name-status", "-M", "-z", from, to]);
	const entries: DiffEntry[] = [];
	let i = 0;
	while (i < fields.length) {
		const status = (fields[i]?.charAt(0) ?? "M") as DiffStatus;
		if (status === "R") {
			entries.push({ path: fields[i + 2] ?? "", status, oldPath: fields[i + 1] ?? "" });
			i += 3;
		} else {
			entries.push({ path: fields[i + 1] ?? "", status });
			i += 2;
		}
	}
	return entries;
}

export async function diffStat(
	repo: string,
	from: string,
	to: string,
): Promise<{ added: number; removed: number }> {
	const fields = await nulDelimitedFields(repo, ["diff", "--numstat", "-z", from, to]);
	return fields.reduce(accumulate, { added: 0, removed: 0 });
}

export async function diffPatch(repo: string, from: string, to: string): Promise<string> {
	return git(repo, ["diff", "--unified=3", from, to]);
}

async function nulDelimitedFields(repo: string, args: string[]): Promise<string[]> {
	const output = await git(repo, args);
	if (output === "") return [];
	// Every record - and so the whole run of output - ends in a NUL, which
	// leaves one trailing empty field after the split; drop it.
	return output.split("\0").slice(0, -1);
}

function accumulate(
	totals: { added: number; removed: number },
	field: string,
): { added: number; removed: number } {
	const [added = "0", removed = "0"] = field.split("\t");
	return {
		added: totals.added + numberOf(added),
		removed: totals.removed + numberOf(removed),
	};
}

function numberOf(field: string): number {
	return field === "-" ? 0 : Number(field);
}
