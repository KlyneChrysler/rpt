// Registers and removes the rpt recorder's hooks in a Claude Code project's
// .claude/settings.json. This file merges into that file - it never replaces
// it, and it never writes anything if the existing file cannot be parsed,
// because overwriting configuration it could not understand would destroy
// hooks, permissions, or environment variables the file's owner set up.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"] as const;
const HOOK_COMMAND = "rpt hook";

type HookEntry = { type: "command"; command: string };
type HookMatcher = { matcher?: string; hooks: HookEntry[] };
type Settings = { hooks?: Record<string, HookMatcher[]> } & Record<string, unknown>;

export async function installHooks(repoRoot: string): Promise<void> {
	const path = settingsPathOf(repoRoot);
	// Read (and fail loudly on malformed JSON) before touching the filesystem
	// at all: a settings file rpt cannot understand must be left untouched.
	const settings = await readSettings(path);
	await mkdir(join(repoRoot, ".claude"), { recursive: true });
	const hooks = { ...settings.hooks };
	for (const eventName of HOOK_EVENTS) hooks[eventName] = withRpt(hooks[eventName] ?? []);
	await writeSettings(path, { ...settings, hooks });
}

export async function uninstallHooks(repoRoot: string): Promise<void> {
	const path = settingsPathOf(repoRoot);
	const settings = await readSettings(path);
	if (settings.hooks === undefined) return;
	const hooks = Object.fromEntries(
		Object.entries(settings.hooks).map(([eventName, matchers]) => [eventName, withoutRpt(matchers)]),
	);
	await writeSettings(path, { ...settings, hooks });
}

function settingsPathOf(repoRoot: string): string {
	return join(repoRoot, ".claude", "settings.json");
}

function withRpt(matchers: HookMatcher[]): HookMatcher[] {
	return hasRpt(matchers) ? matchers : [...matchers, { hooks: [{ type: "command", command: HOOK_COMMAND }] }];
}

function withoutRpt(matchers: HookMatcher[]): HookMatcher[] {
	return matchers
		.map((matcher) => ({ ...matcher, hooks: matcher.hooks.filter((hook) => hook.command !== HOOK_COMMAND) }))
		.filter((matcher) => matcher.hooks.length > 0);
}

function hasRpt(matchers: HookMatcher[]): boolean {
	return matchers.some((matcher) => matcher.hooks.some((hook) => hook.command === HOOK_COMMAND));
}

async function readSettings(path: string): Promise<Settings> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (isMissingFile(error)) return {};
		throw unreadableSettingsError((error as Error).message);
	}
	// Valid JSON is not enough: a top-level array, string, number, or null all
	// parse without error, but none of them is a settings object. Casting one
	// straight to Settings would let the spread below silently replace the
	// user's file with something unrecognizable - refuse instead.
	if (!isPlainObject(parsed)) throw unreadableSettingsError(`expected a JSON object, got ${describeShape(parsed)}`);
	return parsed as Settings;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeShape(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return `a ${typeof value}`;
}

function unreadableSettingsError(detail: string): Error {
	return new Error(`.claude/settings.json is unreadable, refusing to overwrite it: ${detail}`);
}

async function writeSettings(path: string, settings: Settings): Promise<void> {
	await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function isMissingFile(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
