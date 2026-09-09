import { exec } from "node:child_process";
import { access, lstat, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { detectTestCommand } from "./detectTestCommand.js";
import { failed, passed, type RunContext, type Verifier, type VerifierResult } from "./Verifier.js";

const run = promisify(exec);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL = 4000;
const COMMAND_NOT_FOUND_EXIT_CODE = 127;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
// Node reports a maxBuffer kill with this string in place of a numeric exit code -
// not part of the documented ExecException shape, but the real runtime value.
const MAX_BUFFER_EXCEEDED_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

// Signatures an interpreter or shell prints about failing to start at all, never
// something a test framework prints about a test failing.
const STARTUP_FAILURE_PATTERNS: readonly RegExp[] = [
	/command not found/i,
	/: not found\s*$/im,
	/no such file or directory/i,
	/cannot find module/i,
	/module not found/i,
	/modulenotfounderror/i,
	/importerror: no module named/i,
	/is not recognized as an internal or external command/i,
];

export function createTestVerifier(timeoutMs: number = DEFAULT_TIMEOUT_MS): Verifier {
	return {
		id: "tests",
		async run(context: RunContext): Promise<VerifierResult> {
			const command = context.config.testCommand ?? (await detectTestCommand(context.worktree));
			if (command === null) {
				return skippedWithFacts("no test command configured and none could be detected", {});
			}

			const environment = await prepareEnvironment(context.repoRoot, context.worktree);
			if (!environment.ready) {
				return skippedWithFacts(environment.reason, { command, environment: environment.description });
			}

			try {
				return await runCommand(command, context.worktree, timeoutMs, environment.description);
			} finally {
				// Scope the write-through window to this execution, not the worktree's
				// whole lifetime: the link is a live pass-through to the main checkout's
				// dependency directory, so leaving it in place after the run would let a
				// later, unrelated use of this worktree mutate the user's real one.
				if (environment.linkedPath !== null) await rm(environment.linkedPath, { force: true }).catch(() => {});
			}
		},
	};
}

export const testVerifier: Verifier = createTestVerifier();

type Outcome = {
	ok: boolean;
	code: number | string | null;
	killed: boolean;
	signal: NodeJS.Signals | null;
	output: string;
};

type Environment =
	| { ready: true; description: string; linkedPath: string | null }
	| { ready: false; description: string; reason: string };

async function runCommand(
	command: string,
	worktree: string,
	timeoutMs: number,
	environmentDescription: string,
): Promise<VerifierResult> {
	const outcome = await execute(command, worktree, timeoutMs);
	const counts = countsFrom(outcome.output);
	const facts = { command, environment: environmentDescription, ...counts, output: tail(outcome.output) };

	if (outcome.ok) return passed("tests", facts);

	const environmentReason = environmentFailureReason(outcome, timeoutMs, counts);
	if (environmentReason !== null) return skippedWithFacts(environmentReason, facts);

	return failed("tests", `test command exited ${outcome.code}`, facts);
}

// node_modules is the one dependency directory every checkout of this ecosystem
// needs and the worktree, being a bare tracked-files checkout, never has. Other
// detected ecosystems (go, cargo) resolve dependencies from a global cache rather
// than a per-project directory, so there is nothing to link for them.
async function prepareEnvironment(repoRoot: string, worktree: string): Promise<Environment> {
	if (!(await exists(join(worktree, "package.json")))) {
		return { ready: true, description: "no dependency directory required for this project", linkedPath: null };
	}

	const target = join(worktree, "node_modules");
	const entry = await inspectEntry(target);
	if (entry === "usable") {
		return { ready: true, description: "node_modules already present in the worktree", linkedPath: null };
	}
	if (entry === "broken-link") {
		// A stale link left behind (e.g. an interrupted previous run) points at
		// nothing usable - clear it so the symlink call below doesn't throw EEXIST.
		await rm(target, { force: true });
	}

	const source = join(repoRoot, "node_modules");
	if (!(await exists(source))) {
		return {
			ready: false,
			description: "no node_modules directory available",
			reason: "node_modules is missing from the main checkout; cannot establish a runnable environment",
		};
	}
	await symlink(source, target, "dir");
	return { ready: true, description: "linked node_modules from the main checkout", linkedPath: target };
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

type ExecFailure = {
	code?: number | string | null;
	killed?: boolean;
	signal?: NodeJS.Signals | null;
	stdout?: string;
	stderr?: string;
	message: string;
};

async function execute(command: string, cwd: string, timeoutMs: number): Promise<Outcome> {
	try {
		const { stdout, stderr } = await run(command, { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES });
		return { ok: true, code: 0, killed: false, signal: null, output: `${stdout}${stderr}` };
	} catch (error) {
		const failure = error as ExecFailure;
		return {
			ok: false,
			code: failure.code ?? null,
			killed: failure.killed ?? false,
			signal: failure.signal ?? null,
			output: `${failure.stdout ?? ""}${failure.stderr ?? failure.message}`,
		};
	}
}

// Distinguishes "rpt could not run the tests" from "rpt ran the tests and they
// failed", under one rule: if rpt never obtained a genuine numeric exit code, it
// did not observe a result, so the status is skipped - covering a timeout kill of
// rpt's own, a maxBuffer overflow kill, and an externally signalled kill (an OOM
// kill, say) uniformly, each with its own accurate reason. With a genuine numeric
// code, 127 (command not found) is unconditionally environmental; otherwise, parsed
// pass/fail counts are the only signal that the suite actually started - with them,
// a non-zero exit is a real observation and is reported failed even if the output
// also happens to mention a missing module; without them, a startup-shaped failure
// pattern is skipped rather than blamed on the agent. This deliberately errs toward
// skipped: a real failure from a very quiet reporter whose output also matches a
// startup phrase lands as unverified rather than as a false accusation.
function environmentFailureReason(
	outcome: Outcome,
	timeoutMs: number,
	counts: { passed: number | null; failed: number | null },
): string | null {
	if (typeof outcome.code !== "number") {
		return noExitCodeReason(outcome, timeoutMs);
	}
	if (outcome.code === COMMAND_NOT_FOUND_EXIT_CODE) {
		return "test command exited 127 (command not found); treating this as an environment problem, not a test failure";
	}
	if (counts.passed === null && counts.failed === null && matchesStartupFailure(outcome.output)) {
		return "test command failed before producing any parsed test counts, matching a missing interpreter or module signature - not a test failure";
	}
	return null;
}

// rpt's own timeout sets `killed: true` (Node calls .kill() itself); a maxBuffer
// overflow kill does not set `killed`, but replaces the numeric code with Node's
// own sentinel string; anything else with no numeric code but a signal was killed
// by something outside rpt entirely - the OS OOM killer, most plausibly.
function noExitCodeReason(outcome: Outcome, timeoutMs: number): string {
	if (outcome.killed) {
		return `test command was killed after exceeding rpt's timeout deadline of ${formatDuration(timeoutMs)}; rpt did not observe a pass or a failure for this run`;
	}
	if (outcome.code === MAX_BUFFER_EXCEEDED_CODE) {
		return `test command was killed after exceeding rpt's output limit of ${MAX_BUFFER_BYTES / (1024 * 1024)}MB; rpt did not observe a pass or a failure for this run`;
	}
	if (outcome.signal !== null) {
		return `test command was killed by signal ${outcome.signal}, not by rpt; rpt did not observe a pass or a failure for this run`;
	}
	return "test command produced no exit code; rpt did not observe a pass or a failure for this run";
}

function matchesStartupFailure(output: string): boolean {
	return STARTUP_FAILURE_PATTERNS.some((pattern) => pattern.test(output));
}

function formatDuration(ms: number): string {
	if (ms >= 60_000 && ms % 60_000 === 0) return pluralize(ms / 60_000, "minute");
	if (ms >= 1000 && ms % 1000 === 0) return pluralize(ms / 1000, "second");
	return `${ms}ms`;
}

function pluralize(count: number, unit: string): string {
	return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

function countsFrom(output: string): { passed: number | null; failed: number | null } {
	const passedMatch = /(\d+)\s+(?:tests?\s+)?passed/i.exec(output);
	const failedMatch = /(\d+)\s+(?:tests?\s+)?failed/i.exec(output);
	return {
		passed: passedMatch ? Number(passedMatch[1]) : null,
		failed: failedMatch ? Number(failedMatch[1]) : null,
	};
}

function tail(output: string): string {
	return output.length <= OUTPUT_TAIL ? output : output.slice(-OUTPUT_TAIL);
}

function skippedWithFacts(reason: string, facts: Record<string, unknown>): VerifierResult {
	return { id: "tests", status: "skipped", reason, facts };
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
