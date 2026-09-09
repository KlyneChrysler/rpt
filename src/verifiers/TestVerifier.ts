import { exec, type ExecException } from "node:child_process";
import { access, lstat, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { detectTestCommand } from "./detectTestCommand.js";
import { failed, passed, type RunContext, type Verifier, type VerifierResult } from "./Verifier.js";

const run = promisify(exec);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL = 4000;
const COMMAND_NOT_FOUND_EXIT_CODE = 127;

// Below this, an output that also matches a startup-failure pattern (below) is
// treated as the whole story: nothing else ran. Above it - or once counts have
// been parsed - the output is evidence of a suite that actually started, so a
// matching phrase inside it (e.g. one failing test's own "module not found"
// assertion) no longer overrides the exit code.
const SUBSTANTIAL_OUTPUT_THRESHOLD = 500;

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

type Outcome = { ok: boolean; code: number | null; killed: boolean; output: string };

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

	return failed("tests", `test command exited ${outcome.code ?? "unknown"}`, facts);
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

async function execute(command: string, cwd: string, timeoutMs: number): Promise<Outcome> {
	try {
		const { stdout, stderr } = await run(command, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
		return { ok: true, code: 0, killed: false, output: `${stdout}${stderr}` };
	} catch (error) {
		const failure = error as ExecException & { stdout?: string; stderr?: string };
		return {
			ok: false,
			code: failure.code ?? null,
			killed: failure.killed ?? false,
			output: `${failure.stdout ?? ""}${failure.stderr ?? failure.message}`,
		};
	}
}

// Distinguishes "rpt could not run the tests" from "rpt ran the tests and they
// failed". A timeout kill or a missing binary means the suite never finished (or
// never started) running at all, so the exit code observed is not evidence of
// anything - unconditionally environmental. A startup-shaped failure pattern is
// evidence only when nothing else happened: once the suite has produced parsed
// counts or a substantial amount of output, it demonstrably started, and its exit
// code is a real observation that must not be discarded.
function environmentFailureReason(
	outcome: Outcome,
	timeoutMs: number,
	counts: { passed: number | null; failed: number | null },
): string | null {
	if (outcome.killed) {
		return `test command was killed after rpt's ${formatDuration(timeoutMs)} timeout deadline; rpt did not observe a pass or a failure for this run`;
	}
	if (outcome.code === COMMAND_NOT_FOUND_EXIT_CODE) {
		return "test command exited 127 (command not found); treating this as an environment problem, not a test failure";
	}
	if (!startedRunning(outcome, counts) && matchesStartupFailure(outcome.output)) {
		return "test command failed before producing any test output, matching a missing interpreter or module signature - not a test failure";
	}
	return null;
}

function startedRunning(outcome: Outcome, counts: { passed: number | null; failed: number | null }): boolean {
	return counts.passed !== null || counts.failed !== null || outcome.output.length > SUBSTANTIAL_OUTPUT_THRESHOLD;
}

function matchesStartupFailure(output: string): boolean {
	return STARTUP_FAILURE_PATTERNS.some((pattern) => pattern.test(output));
}

function formatDuration(ms: number): string {
	if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} minute`;
	if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000} second`;
	return `${ms}ms`;
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
