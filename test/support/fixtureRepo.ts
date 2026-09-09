import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../src/git/exec.js";

export async function makeFixtureRepo(): Promise<string> {
	const repo = await mkdtemp(join(tmpdir(), "rpt-repo-"));
	await git(repo, ["init", "-q", "-b", "main"]);
	await git(repo, ["config", "user.email", "test@example.com"]);
	await git(repo, ["config", "user.name", "rpt test"]);
	await writeFile(join(repo, "README.md"), "seed\n");
	await git(repo, ["add", "-A"]);
	await git(repo, ["commit", "-q", "-m", "seed"]);
	return repo;
}

export async function writeAndStage(repo: string, path: string, body: string): Promise<void> {
	await writeFile(join(repo, path), body);
	await git(repo, ["add", path]);
}
