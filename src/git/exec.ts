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
		const failure = error as { code?: number | string; stderr?: string; message: string };
		throw new GitError(args, failure.code ?? null, failure.stderr ?? "", failure.message);
	}
}
