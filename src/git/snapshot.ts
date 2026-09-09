import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunId } from "../domain/events.js";
import { git, GitError } from "./exec.js";

export type SnapshotLabel = "base" | "end";

export async function headSha(repo: string): Promise<string | null> {
	try {
		return await git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]);
	} catch (error) {
		if (error instanceof GitError && isUnresolvableRef(error)) return null;
		throw error;
	}
}

// `rev-parse --verify --quiet` exits 1 with empty stderr precisely when the
// ref cannot be resolved (e.g. no commits yet). Any other shape - a different
// exit code, or output on stderr - is a genuine failure (missing git binary,
// bad path, corrupted repo, permissions) and must not be swallowed as "no commits".
function isUnresolvableRef(error: GitError): boolean {
	return error.exitCode === 1 && error.stderr.trim() === "";
}

export async function createSnapshot(
	repo: string,
	runId: RunId,
	label: SnapshotLabel,
): Promise<string> {
	const scratch = await mkdtemp(join(tmpdir(), "rpt-index-"));
	const env = { GIT_INDEX_FILE: join(scratch, "index") };
	try {
		await git(repo, ["add", "-A"], env);
		const tree = await git(repo, ["write-tree"], env);
		const sha = await commitTree(repo, tree);
		await git(repo, ["update-ref", refFor(runId, label), sha]);
		return sha;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

export function refFor(runId: RunId, label: SnapshotLabel): string {
	return `refs/rpt/runs/${runId}/${label}`;
}

async function commitTree(repo: string, tree: string): Promise<string> {
	const parent = await headSha(repo);
	const args = ["commit-tree", tree, "-m", "rpt snapshot"];
	return git(repo, parent === null ? args : [...args, "-p", parent]);
}
