import { exec } from "node:child_process";
import { access, symlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { detectTestCommand } from "./detectTestCommand.js";
import { failed, passed, type RunContext, type Verifier, type VerifierResult } from "./Verifier.js";

const run = promisify(exec);
const TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL = 4000;
const COMMAND_NOT_FOUND_EXIT_CODE = 127;

// Patterns that mean "the environment could not run the tests", never "the tests
// failed". A verifier that mistook these for a real failure would blame the agent
// for an rpt-side setup gap, which is worse for trust than reporting nothing.
const ENVIRONMENT_FAILURE_PATTERNS: readonly RegExp[] = [
	/command not found/i,
	/: not found\s*$/im,
	/no such file or directory/i,
	/cannot find module/i,
	/module not found/i,
	/modulenotfounderror/i,
	/importerror: no module named/i,
	/is not recognized as an internal or external command/i,
];

export const testVerifier: Verifier = {
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

		const outcome = await execute(command, context.worktree);
		const facts = {
			command,
			environment: environment.description,
			...countsFrom(outcome.output),
			output: tail(outcome.output),
		};

		if (outcome.ok) return passed("tests", facts);

		const environmentReason = environmentFailureReason(outcome);
		if (environmentReason !== null) return skippedWithFacts(environmentReason, facts);

		return failed("tests", `test command exited ${outcome.code}`, facts);
	},
};

type Outcome = { ok: boolean; code: number; output: string };

type Environment = { ready: true; description: string } | { ready: false; description: string; reason: string };

// node_modules is the one dependency directory every checkout of this ecosystem
// needs and the worktree, being a bare tracked-files checkout, never has. Other
// detected ecosystems (go, cargo) resolve dependencies from a global cache rather
// than a per-project directory, so there is nothing to link for them.
async function prepareEnvironment(repoRoot: string, worktree: string): Promise<Environment> {
	if (!(await exists(join(worktree, "package.json")))) {
		return { ready: true, description: "no dependency directory required for this project" };
	}
	if (await exists(join(worktree, "node_modules"))) {
		return { ready: true, description: "node_modules already present in the worktree" };
	}
	const source = join(repoRoot, "node_modules");
	if (!(await exists(source))) {
		return {
			ready: false,
			description: "no node_modules directory available",
			reason: "node_modules is missing from the main checkout; cannot establish a runnable environment",
		};
	}
	await symlink(source, join(worktree, "node_modules"), "dir");
	return { ready: true, description: "linked node_modules from the main checkout" };
}

async function execute(command: string, cwd: string): Promise<Outcome> {
	try {
		const { stdout, stderr } = await run(command, { cwd, timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
		return { ok: true, code: 0, output: `${stdout}${stderr}` };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string; message: string };
		return {
			ok: false,
			code: failure.code ?? 1,
			output: `${failure.stdout ?? ""}${failure.stderr ?? failure.message}`,
		};
	}
}

// Distinguishes "rpt could not run the tests" from "rpt ran the tests and they
// failed". Conservative by design: only a strong, specific signal (a shell's
// "command not found" exit code, or an interpreter's own module-resolution
// error) is treated as environmental. Anything else is a genuine test failure.
function environmentFailureReason(outcome: Outcome): string | null {
	if (outcome.code === COMMAND_NOT_FOUND_EXIT_CODE) {
		return "test command exited 127 (command not found); treating this as an environment problem, not a test failure";
	}
	for (const pattern of ENVIRONMENT_FAILURE_PATTERNS) {
		if (pattern.test(outcome.output)) {
			return "test command output indicates a missing interpreter or module, not a test failure";
		}
	}
	return null;
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
