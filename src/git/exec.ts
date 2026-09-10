import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export class GitError extends Error {
	readonly exitCode: number | string | null;
	readonly stderr: string;

	constructor(args: string[], exitCode: number | string | null, stderr: string, fallback: string) {
		super(`git ${args.join(" ")} failed: ${stderr.trim() || fallback}`);
		this.name = "GitError";
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}

// Everything git exports into a hook's environment to scope its child processes
// to the invocation in progress. `rpt gate` runs from pre-commit and `rpt
// record` from post-commit, so every git command rpt runs there inherits these
// unless they are removed - and they are actively wrong for rpt's purposes.
// GIT_DIR alone is enough to break the whole gate: `git worktree add` resolves
// the new worktree's `.git`, which is a file rather than a directory, and fails
// with "index file open failed: Not a directory" before a single verifier runs.
// A verification that only fails when invoked from the hook it exists to serve
// is worse than one that never worked at all, because it looks fine everywhere
// it is tested.
//
// Stripped before the caller's own env is spread on top, so a caller that
// deliberately sets one of these - createSnapshot passes GIT_INDEX_FILE to keep
// the user's real index untouched - still wins.
const INHERITED_GIT_SCOPE = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_PREFIX",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	"GIT_QUARANTINE_PATH",
	"GIT_INDEX_VERSION",
] as const;

function environmentFor(env: Record<string, string>): NodeJS.ProcessEnv {
	const inherited = { ...process.env };
	for (const name of INHERITED_GIT_SCOPE) delete inherited[name];
	return { ...inherited, ...env };
}

export async function git(
	repo: string,
	args: string[],
	env: Record<string, string> = {},
): Promise<string> {
	try {
		const { stdout } = await run("git", args, {
			cwd: repo,
			env: environmentFor(env),
			maxBuffer: 64 * 1024 * 1024,
		});
		return stdout.trimEnd();
	} catch (error) {
		const failure = error as { code?: number | string; stderr?: string; message: string };
		throw new GitError(args, failure.code ?? null, failure.stderr ?? "", failure.message);
	}
}
