import { git } from "./exec.js";
import { parseHunkHeader } from "./hunkHeader.js";

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

// git's rename detection is on by default for `git diff`, -M or not, so a
// numstat record for a pure rename is not "added\tremoved\tpath" like every
// other record. It is a numeric field whose path slot is empty, followed by
// the old and new path as two further NUL fields of their own - neither of
// them a count. Treating every field as its own record would feed those bare
// filenames to Number() and corrupt the running total to NaN.
export async function diffStat(
	repo: string,
	from: string,
	to: string,
): Promise<{ added: number; removed: number }> {
	const fields = await nulDelimitedFields(repo, ["diff", "--numstat", "-z", from, to]);
	let totals = { added: 0, removed: 0 };
	let i = 0;
	while (i < fields.length) {
		const [added = "0", removed = "0", path = ""] = (fields[i] ?? "").split("\t");
		totals = { added: totals.added + numberOf(added), removed: totals.removed + numberOf(removed) };
		i += path === "" ? 3 : 1;
	}
	return totals;
}

export async function diffPatch(repo: string, from: string, to: string): Promise<string> {
	return git(repo, ["diff", "--unified=3", from, to]);
}

// --unified=0 drops all context lines, so every line a hunk's header claims
// for the new file is a genuinely changed one - no need to walk hunk content
// the way a content-scanning parser (scanSecrets) has to. A pure deletion's
// hunk header carries a zero-length new-file range ("+0,0"), so it naturally
// contributes no lines; "+++ /dev/null" for that same deletion is still
// matched explicitly, so a later hunk can never be misattributed to whatever
// file happened to be current before it.
export async function changedLines(repo: string, from: string, to: string): Promise<Map<string, Set<number>>> {
	const patch = await git(repo, ["diff", "--unified=0", from, to]);
	const changed = new Map<string, Set<number>>();
	let file: string | null = null;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+++ ")) {
			file = line.startsWith("+++ b/") ? line.slice("+++ b/".length) : null;
			if (file !== null) changed.set(file, new Set());
			continue;
		}
		if (file === null || !line.startsWith("@@")) continue;
		const header = parseHunkHeader(line);
		if (header === null) continue;
		const lines = changed.get(file)!;
		for (let offset = 0; offset < header.newCount; offset += 1) lines.add(header.newStart + offset);
	}
	return changed;
}

async function nulDelimitedFields(repo: string, args: string[]): Promise<string[]> {
	const output = await git(repo, args);
	if (output === "") return [];
	// Every record - and so the whole run of output - ends in a NUL, which
	// leaves one trailing empty field after the split; drop it.
	return output.split("\0").slice(0, -1);
}

function numberOf(field: string): number {
	return field === "-" ? 0 : Number(field);
}
