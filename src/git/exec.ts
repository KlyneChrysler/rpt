import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export class GitError extends Error {
	constructor(args: string[], stderr: string) {
		super(`git ${args.join(" ")} failed: ${stderr.trim()}`);
		this.name = "GitError";
	}
}

export async function git(
	repo: string,
	args: string[],
	env: Record<string, string> = {},
): Promise<string> {
	try {
		const { stdout } = await run("git", args, {
			cwd: repo,
			env: { ...process.env, ...env },
			maxBuffer: 64 * 1024 * 1024,
		});
		return stdout.trimEnd();
	} catch (error) {
		throw new GitError(args, String((error as { stderr?: string }).stderr ?? (error as Error).message));
	}
}
