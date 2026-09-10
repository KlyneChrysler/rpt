import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const GIT_HOOK_MARKER = "# rpt gate";

// `exit 1` rather than letting the exit status fall through: `rpt gate` is
// the last command in the chained script, so a hook that ends with it would
// already return its status - but a later chained block appended below by
// something else would silently become the status instead. Making the refusal
// explicit keeps the gate's answer the hook's answer.
const PRE_COMMIT = `#!/bin/sh
${GIT_HOOK_MARKER}
rpt gate || exit 1
`;

// Never fails the commit. By the time post-commit runs the commit exists, so
// a non-zero exit here cannot undo it - it can only report a failure the user
// can do nothing about, on a step whose entire job is to annotate.
const POST_COMMIT = `#!/bin/sh
${GIT_HOOK_MARKER}
rpt record --quiet || true
`;

// Chains rather than overwrites: a repository's existing pre-commit hook is
// somebody's linter or formatter, and replacing it to install an
// accountability tool would be the tool causing exactly the kind of silent
// loss it exists to prevent.
export async function installGitHooks(repoRoot: string): Promise<boolean> {
	const dir = join(repoRoot, ".git", "hooks");
	await mkdir(dir, { recursive: true });
	const preCommit = await install(join(dir, "pre-commit"), PRE_COMMIT);
	const postCommit = await install(join(dir, "post-commit"), POST_COMMIT);
	return preCommit || postCommit;
}

async function install(path: string, body: string): Promise<boolean> {
	const existing = await readOrNull(path);
	if (existing !== null && existing.includes(GIT_HOOK_MARKER)) return false;
	await writeFile(path, existing === null ? body : appended(existing, body), "utf8");
	await chmod(path, 0o755);
	return true;
}

// The shebang is dropped from the appended copy: a second `#!/bin/sh` in the
// middle of a script is an ordinary comment, but it reads as a second script
// beginning there, and anyone editing the file later is entitled to be
// confused by that.
function appended(existing: string, body: string): string {
	return `${existing.trimEnd()}\n\n${body.split("\n").slice(1).join("\n")}`;
}

async function readOrNull(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
