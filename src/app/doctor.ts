import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { loadConfig } from "../config/load.js";
import { pruneWorktrees } from "../git/worktree.js";
import { loadPricing } from "../pricing/table.js";
import { daemonLockHeld } from "../store/daemonLock.js";
import { GIT_HOOK_MARKER } from "./installGitHooks.js";
import { rptDirOf, socketPathOf } from "../store/paths.js";
import { listRuns } from "../store/runIndex.js";
import { loadRun } from "./loadRun.js";

export type Check = { id: string; ok: boolean; detail: string };

const AGENT_HOOK_COMMAND = "rpt hook";

// Every check runs independently and catches its own failure, so one broken
// check reports itself rather than hiding the six that would have told the
// user what was actually wrong. A diagnostic tool that stops at the first
// problem is the least useful thing in the box.
export async function doctor(repoRoot: string): Promise<Check[]> {
	return Promise.all([
		guarded("agent-hooks", () => agentHooks(repoRoot)),
		guarded("git-hooks", () => gitHooks(repoRoot)),
		guarded("config", () => config(repoRoot)),
		guarded("pricing", () => pricing(repoRoot)),
		guarded("worktrees", () => worktrees(repoRoot)),
		guarded("daemon", () => daemon(repoRoot)),
	]);
}

async function guarded(id: string, check: () => Promise<Omit<Check, "id">>): Promise<Check> {
	try {
		return { id, ...(await check()) };
	} catch (error) {
		return { id, ok: false, detail: `check failed: ${messageOf(error)}` };
	}
}

async function agentHooks(repoRoot: string): Promise<Omit<Check, "id">> {
	const settings = await readOrNull(join(repoRoot, ".claude", "settings.json"));
	if (settings === null) return { ok: false, detail: 'no .claude/settings.json - run "rpt init"' };
	return settings.includes(AGENT_HOOK_COMMAND)
		? { ok: true, detail: "claude code hooks registered" }
		: { ok: false, detail: 'settings.json has no rpt hook - run "rpt init"' };
}

async function gitHooks(repoRoot: string): Promise<Omit<Check, "id">> {
	const hook = await readOrNull(join(repoRoot, ".git", "hooks", "pre-commit"));
	if (hook === null) return { ok: false, detail: 'no .git/hooks/pre-commit - run "rpt init"' };
	return hook.includes(GIT_HOOK_MARKER)
		? { ok: true, detail: "pre-commit gate installed" }
		: { ok: false, detail: 'pre-commit hook exists but does not run the gate - run "rpt init"' };
}

async function config(repoRoot: string): Promise<Omit<Check, "id">> {
	try {
		const resolved = await loadConfig(repoRoot);
		return { ok: true, detail: `valid, thresholds ${resolved.thresholds.review}/${resolved.thresholds.approval}/${resolved.thresholds.block}` };
	} catch (error) {
		return { ok: false, detail: messageOf(error) };
	}
}

// Reports how many distinct models rpt has actually seen used and cannot
// price. A missing rate is never an error rpt papers over with a zero, so
// this is the only place a user finds out their cost figures are absent.
async function pricing(repoRoot: string): Promise<Omit<Check, "id">> {
	const rptDir = rptDirOf(repoRoot);
	const table = await loadPricing(rptDir);
	const models = new Set<string>();
	for (const entry of await listRuns(rptDir)) {
		for (const usage of await usageOf(repoRoot, entry.id)) models.add(usage);
	}
	const unpriced = [...models].filter((model) => table.rates[model] === undefined);
	if (models.size === 0) {
		return Object.keys(table.rates).length === 0
			? { ok: false, detail: "no model rates set - costs will be reported as unknown" }
			: { ok: true, detail: `${Object.keys(table.rates).length} model rate(s) configured` };
	}
	return unpriced.length === 0
		? { ok: true, detail: `${models.size} model(s) used, all priced` }
		: { ok: false, detail: `unpriced model(s): ${unpriced.join(", ")}` };
}

async function usageOf(repoRoot: string, runId: number): Promise<string[]> {
	try {
		return (await loadRun(repoRoot, runId)).usage.map((entry) => entry.model);
	} catch {
		// A run that cannot be projected has no usage to report, and diagnosing
		// that is the run list's job, not the pricing check's.
		return [];
	}
}

async function worktrees(repoRoot: string): Promise<Omit<Check, "id">> {
	const removed = await pruneWorktrees(repoRoot);
	return removed.length === 0
		? { ok: true, detail: "no orphaned verification worktrees" }
		: { ok: true, detail: `pruned ${removed.length} orphaned worktree(s)` };
}

// The daemon is an optimisation, not a requirement: without it the hook appends
// to the log directly under a file lock, and the next hook starts one. Its
// absence is reported as information rather than as a fault, so `rpt doctor` in
// CI does not fail for a component nothing needed.
//
// Asks the lock, not the socket file. A socket file outlives a daemon that was
// killed rather than closed, so "the file is there" answers a different
// question from "something is listening" - and answering the wrong one told
// users a dead daemon was healthy.
async function daemon(repoRoot: string): Promise<Omit<Check, "id">> {
	const rptDir = rptDirOf(repoRoot);
	if (!(await daemonLockHeld(rptDir))) {
		return { ok: true, detail: "not running - hooks append directly and will start one, which is fine" };
	}
	const socketPath = socketPathOf(rptDir);
	return (await socketAccepts(socketPath))
		? { ok: true, detail: `running, accepting connections at ${socketPath}` }
		: { ok: false, detail: `a daemon holds the lock but ${socketPath} is not accepting connections - remove ${socketPath} and let the next hook restart it` };
}

const SOCKET_PROBE_MS = 250;

function socketAccepts(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(socketPath);
		let settled = false;
		const settle = (accepted: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(accepted);
		};
		// An explicit timer, not socket.setTimeout: that one is an idle timeout
		// and does not reliably bound a connect that never completes. Connecting
		// to a unix socket whose file is gone errors at once, so this went
		// unnoticed until Windows, where connecting to a named pipe that no
		// longer exists simply waits - and `rpt doctor`, whose whole job is
		// answering questions about a possibly-dead daemon, hung.
		const timer = setTimeout(() => settle(false), SOCKET_PROBE_MS);
		socket.on("error", () => settle(false));
		socket.on("connect", () => settle(true));
	});
}

async function readOrNull(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// A unix socket exists but cannot be read as a file. That is presence,
		// not absence, and reporting it as absence would tell a user to start a
		// daemon that is already running.
		if (code === "ENXIO" || code === "EOPNOTSUPP" || code === "EINVAL") return "";
		if (code === "ENOENT") return null;
		throw error;
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
