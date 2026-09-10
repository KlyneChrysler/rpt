import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RunId } from "../domain/events.js";

const GIT_MARKER = ".git";
const RPT_MARKER = ".rpt";

export function rptDirOf(repoRoot: string): string {
	return join(repoRoot, ".rpt");
}

export function runIndexOf(rptDir: string): string {
	return join(rptDir, "index.jsonl");
}

export function runDirOf(rptDir: string, runId: RunId): string {
	return join(rptDir, "runs", String(runId));
}

export function eventLogOf(rptDir: string, runId: RunId): string {
	return join(runDirOf(rptDir, runId), "events.jsonl");
}

export function verdictPathOf(rptDir: string, runId: RunId): string {
	return join(runDirOf(rptDir, runId), "verdict.json");
}

export function currentPointerOf(rptDir: string): string {
	return join(rptDir, "current");
}

export function pricingFileOf(rptDir: string): string {
	return join(rptDir, "pricing.json");
}

// A session that never got as far as a run has no event log to record a gap in,
// so its one durable trace lives here instead.
export function startFailuresOf(rptDir: string): string {
	return join(rptDir, "start-failures.jsonl");
}

// The daemon owns the server; the store owns the file, because the file lives
// under .rpt and nothing outside this layer may decide where anything there goes.
export function socketPathOf(rptDir: string): string {
	return join(rptDir, "daemon.sock");
}

// A repository root is not the working directory. An agent's hooks, and a user's
// own shell, fire from wherever inside the tree they happen to be, and treating
// that directory as the root made every subdirectory look like a repository with
// no history - reported as an empty list and a zero exit, which is the same
// answer a genuinely empty repository gives. Walking up removes the ambiguity;
// returning null rather than a guess lets the caller say so out loud.
export async function findGitRoot(startDir: string): Promise<string | null> {
	return findUpwards(startDir, [GIT_MARKER]);
}

// Either marker: .git for a repository, .rpt for a directory rpt has recorded in
// even if it is not a git repository. Whichever is found first walking up wins,
// so a nested repository is not silently answered for by its parent.
export async function findRepoRoot(startDir: string): Promise<string | null> {
	return findUpwards(startDir, [GIT_MARKER, RPT_MARKER]);
}

async function findUpwards(startDir: string, markers: readonly string[]): Promise<string | null> {
	let dir = resolve(startDir);
	for (;;) {
		for (const marker of markers) {
			if (await exists(join(dir, marker))) return dir;
		}
		const parent = dirname(dir);
		// dirname("/") is "/": the filesystem root is where the walk ends.
		if (parent === dir) return null;
		dir = parent;
	}
}

// stat, not access: a git worktree's .git is a file, not a directory, and both
// count. Any error at all - missing, unreadable, a broken symlink - means the
// marker is not usable here, so the walk continues upward.
async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
