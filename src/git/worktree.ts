import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./exec.js";

export type Worktree = { path: string; dispose(): Promise<void> };

export async function openWorktree(repoRoot: string, sha: string): Promise<Worktree> {
	const parent = await mkdtemp(join(tmpdir(), "rpt-wt-"));
	const path = join(parent, "tree");
	await git(repoRoot, ["worktree", "add", "--detach", "--quiet", path, sha]);
	return { path, dispose: () => dispose(repoRoot, parent, path) };
}

export async function pruneWorktrees(repoRoot: string): Promise<string[]> {
	const before = await listRptWorktrees(repoRoot);
	await git(repoRoot, ["worktree", "prune"]);
	const after = await listRptWorktrees(repoRoot);
	return before.filter((path) => !after.includes(path));
}

async function dispose(repoRoot: string, parent: string, path: string): Promise<void> {
	await git(repoRoot, ["worktree", "remove", "--force", path]);
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
