import { access, lstat, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";

export type DependencyLink =
	| { status: "not-required" }
	| { status: "already-present" }
	| { status: "linked"; linkedPath: string }
	| { status: "unavailable"; reason: string };

// node_modules is the one dependency directory every checkout of this
// ecosystem needs and a verification worktree, being a bare tracked-files
// checkout, never has. Shared by every verifier that runs a project command
// against the worktree (the test suite, a coverage run, npm audit) so the
// link-and-clean-up mechanics live in exactly one place instead of being
// hand-rolled again each time a new one needs it.
export async function linkDependencies(repoRoot: string, worktree: string): Promise<DependencyLink> {
	if (!(await exists(join(worktree, "package.json")))) return { status: "not-required" };

	const target = join(worktree, "node_modules");
	const entry = await inspectEntry(target);
	if (entry === "usable") return { status: "already-present" };
	if (entry === "broken-link") {
		// A stale link left behind (e.g. an interrupted previous run) points at
		// nothing usable - clear it so the symlink call below doesn't throw EEXIST.
		await rm(target, { force: true });
	}

	const source = join(repoRoot, "node_modules");
	if (!(await exists(source))) {
		return {
			status: "unavailable",
			reason: "node_modules is missing from the main checkout; cannot establish a runnable environment",
		};
	}
	await symlink(source, target, "dir");
	return { status: "linked", linkedPath: target };
}

// Scopes the write-through window to the caller's own execution, not the
// worktree's whole lifetime: the link is a live pass-through to the main
// checkout's dependency directory, so leaving it in place after the run would
// let a later, unrelated use of this worktree mutate the user's real one.
export async function unlinkDependencies(link: DependencyLink): Promise<void> {
	if (link.status === "linked") await rm(link.linkedPath, { force: true }).catch(() => {});
}

async function inspectEntry(path: string): Promise<"absent" | "usable" | "broken-link"> {
	let entryStat;
	try {
		entryStat = await lstat(path);
	} catch {
		return "absent";
	}
	if (!entryStat.isSymbolicLink()) return "usable";
	try {
		await stat(path); // follows the link; throws if the target is gone
		return "usable";
	} catch {
		return "broken-link";
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
