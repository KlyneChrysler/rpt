import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./exec.js";

export type Worktree = { path: string; dispose(): Promise<void> };

export async function openWorktree(repoRoot: string, sha: string): Promise<Worktree> {
	const parent = await mkdtemp(join(tmpdir(), "rpt-wt-"));
	const path = join(parent, "tree");
	try {
		await git(repoRoot, ["worktree", "add", "--detach", "--quiet", path, sha]);
	} catch (error) {
		// `add` rejects before a handle exists, so nobody else can ever dispose
		// this parent directory - clean it up ourselves before rethrowing.
		await rm(parent, { recursive: true, force: true });
		throw error;
	}
	return { path, dispose: () => dispose(repoRoot, parent, path) };
}

// Repo-global: git has no per-worktree prune, only a whole-repo sweep. Fine here
// since rpt is the only thing expected to create worktrees under this repo, but a
// future caller sharing the repo with other worktree users would see this clear
// their entries too.
export async function pruneWorktrees(repoRoot: string): Promise<string[]> {
	const before = await listRptWorktrees(repoRoot);
	await git(repoRoot, ["worktree", "prune"]);
	const after = await listRptWorktrees(repoRoot);
	return before.filter((path) => !after.includes(path));
}

async function dispose(repoRoot: string, parent: string, path: string): Promise<void> {
	try {
		await git(repoRoot, ["worktree", "remove", "--force", path]);
	} catch {
		// The most common cause of a failed removal is a lock, which - unlike a
		// missing directory - `git worktree prune` never clears on its own. Unlock
		// (best-effort; a no-op error here just means it wasn't locked) and delete
		// the directory ourselves so prune has what it needs to drop the orphaned
		// registration, keeping this path free for the next run to reuse.
		await git(repoRoot, ["worktree", "unlock", path]).catch(() => {});
		await rm(parent, { recursive: true, force: true });
		await git(repoRoot, ["worktree", "prune"]);
		return;
	}
	await rm(parent, { recursive: true, force: true });
}

async function listRptWorktrees(repoRoot: string): Promise<string[]> {
	const output = await git(repoRoot, ["worktree", "list", "--porcelain"]);
	return output
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length))
		.filter((path) => path.includes("rpt-wt-"));
}
