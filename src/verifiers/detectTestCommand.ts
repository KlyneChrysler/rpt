import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function detectTestCommand(worktree: string): Promise<string | null> {
	return (
		(await nodeCommand(worktree)) ??
		(await presentThen(worktree, "go.mod", "go test ./...")) ??
		(await presentThen(worktree, "Cargo.toml", "cargo test")) ??
		(await pythonCommand(worktree)) ??
		(await presentThen(worktree, "Makefile", "make test"))
	);
}

async function nodeCommand(worktree: string): Promise<string | null> {
	const manifest = await readJson(join(worktree, "package.json"));
	const scripts = (manifest?.scripts ?? {}) as Record<string, unknown>;
	if (typeof scripts.test !== "string") return null;
	return `${await nodeRunner(worktree)} test`;
}

async function nodeRunner(worktree: string): Promise<string> {
	if (await exists(join(worktree, "pnpm-lock.yaml"))) return "pnpm";
	if (await exists(join(worktree, "yarn.lock"))) return "yarn";
	if (await exists(join(worktree, "bun.lockb"))) return "bun";
	return "npm";
}

async function pythonCommand(worktree: string): Promise<string | null> {
	const body = await readText(join(worktree, "pyproject.toml"));
	if (body === null) return null;
	return body.includes("pytest") ? "pytest" : null;
}

async function presentThen(worktree: string, file: string, command: string): Promise<string | null> {
	return (await exists(join(worktree, file))) ? command : null;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function readText(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
	const body = await readText(path);
	if (body === null) return null;
	try {
		return JSON.parse(body) as Record<string, unknown>;
	} catch {
		return null;
	}
}
