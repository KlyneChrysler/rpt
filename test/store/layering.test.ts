import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Spec section 5: only src/store writes to .rpt. Building the path is the first
// step of that write, so the rule is enforced on the path literal rather than on
// the filesystem call - a module that knows where .rpt keeps its files already
// owns a decision the store layer is supposed to own alone. Naming one of these
// files in prose (an error message, a .gitignore line) is not path building, so
// only a literal inside a join() call counts.
const JOIN_CALL_START_RE = /\bjoin\s*\(/g;
const RPT_INTERNAL_LITERAL_RE =
	/["'](\.rpt|daemon\.sock|index\.jsonl|events\.jsonl|pricing\.json|verdict\.json|approval\.json|current|start-failures\.jsonl)["']/;

// A regex with a `[^)]*` capture cannot see past a nested call's own closing
// paren - join(runDirOf(rptDir, runId), "approval.json") stops capturing at
// runDirOf's ")", so the protected literal sitting after it, as the join
// call's real second argument, was never even examined. Scanning by hand,
// tracking paren depth (and skipping over string contents, so a quoted ")"
// inside an argument does not end the scan early) instead of matching once
// with a regex, finds the join call's true closing paren regardless of what
// is nested inside its argument list.
function extractCallArguments(source: string, openParenIndex: number): string {
	let depth = 0;
	let quote: string | null = null;
	let args = "";
	for (let i = openParenIndex; i < source.length; i += 1) {
		const ch = source[i]!;
		if (quote !== null) {
			args += ch;
			if (ch === "\\") {
				i += 1;
				args += source[i] ?? "";
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			args += ch;
			continue;
		}
		if (ch === "(") {
			depth += 1;
			if (depth > 1) args += ch;
			continue;
		}
		if (ch === ")") {
			depth -= 1;
			if (depth === 0) break;
			args += ch;
			continue;
		}
		args += ch;
	}
	return args;
}

export function findRptPathViolations(relativePath: string, source: string): string[] {
	if (relativePath.startsWith("store/")) return [];
	const violations: string[] = [];
	for (const match of source.matchAll(JOIN_CALL_START_RE)) {
		const openParenIndex = match.index! + match[0].length - 1;
		const args = extractCallArguments(source, openParenIndex);
		if (RPT_INTERNAL_LITERAL_RE.test(args)) {
			violations.push(`${relativePath}: builds an .rpt path outside the store layer: join(${args})`);
		}
	}
	return violations;
}

// Spec: only src/git invokes the git binary - every other layer goes through
// its diff/snapshot/worktree helpers instead. The rule is not "no
// child_process outside src/git": every verifier legitimately shells out to
// whatever command the run or the user configured (the test suite, npm
// audit, a coverage command), and none of those are git invocations. What
// counts is specifically a call whose first argument is the literal command
// "git" - matching both an execFile-style call with separate args
// (run("git", args)) and a single shell-string form (exec("git status")).
// "gitignore" or any other identifier that runs straight past "git" with no
// quote or whitespace boundary is deliberately not matched, the same way the
// path rule above does not mistake a file name in prose for path building.
const GIT_INVOCATION_RE = /\b\w+\s*\(\s*["'`]git(?:["'`]|\s)/g;

export function findGitInvocationViolations(relativePath: string, source: string): string[] {
	if (relativePath.startsWith("git/")) return [];
	return [...source.matchAll(GIT_INVOCATION_RE)].map(
		(match) => `${relativePath}: invokes the git binary outside src/git: ${match[0].trim()}`,
	);
}

async function sourceFiles(dir: string, prefix = ""): Promise<{ path: string; source: string }[]> {
	const found: { path: string; source: string }[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const relative = `${prefix}${entry.name}`;
		if (entry.isDirectory()) found.push(...(await sourceFiles(join(dir, entry.name), `${relative}/`)));
		else if (entry.name.endsWith(".ts")) found.push({ path: relative, source: await readFile(join(dir, entry.name), "utf8") });
	}
	return found;
}

describe("store owns every path under .rpt", () => {
	it("finds no module outside src/store building one", async () => {
		const violations = (await sourceFiles("src")).flatMap((file) => findRptPathViolations(file.path, file.source));
		expect(violations).toEqual([]);
	});

	it("flags a daemon that knows where the socket lives", () => {
		const source = `return join(rptDir, "daemon.sock");`;
		expect(findRptPathViolations("daemon/protocol.ts", source)).toHaveLength(1);
	});

	it("allows the store layer itself to build one", () => {
		const source = `return join(rptDir, "index.jsonl");`;
		expect(findRptPathViolations("store/paths.ts", source)).toEqual([]);
	});

	it("does not mistake an error message naming a file for path building", () => {
		const source = `throw new Error(".rpt/pricing.json is unreadable");`;
		expect(findRptPathViolations("pricing/table.ts", source)).toEqual([]);
	});

	// Regression: the previous [^)]* capture stopped at runDirOf's own closing
	// paren, so a protected filename passed as the join call's second argument
	// - after a nested helper call - was never examined at all.
	it("catches a protected filename nested behind another call in the same join", () => {
		const source = `return join(runDirOf(rptDir, runId), "approval.json");`;
		expect(findRptPathViolations("app/approveRun.ts", source)).toHaveLength(1);
	});

	it("still allows the store layer to build a path nested behind another call", () => {
		const source = `return join(runDirOf(rptDir, runId), "approval.json");`;
		expect(findRptPathViolations("store/approvals.ts", source)).toEqual([]);
	});

	it("does not let a quoted close-paren inside an argument end the scan early", () => {
		const source = `return join(describe(")"), "index.jsonl");`;
		expect(findRptPathViolations("app/rogue.ts", source)).toHaveLength(1);
	});
});

describe("only src/git invokes the git binary", () => {
	it("finds no module outside src/git calling it", async () => {
		const violations = (await sourceFiles("src")).flatMap((file) => findGitInvocationViolations(file.path, file.source));
		expect(violations).toEqual([]);
	});

	it("flags a verifier that shells out to git directly instead of using src/git", () => {
		const source = `const { stdout } = await run("git", ["status"]);`;
		expect(findGitInvocationViolations("verifiers/RogueVerifier.ts", source)).toHaveLength(1);
	});

	it("flags a single shell-string invocation just as well as an execFile-style one", () => {
		const source = `await run("git status");`;
		expect(findGitInvocationViolations("app/rogue.ts", source)).toHaveLength(1);
	});

	it("allows the git module itself to invoke git", () => {
		const source = `const { stdout } = await run("git", args, { cwd: repo });`;
		expect(findGitInvocationViolations("git/exec.ts", source)).toEqual([]);
	});

	it("does not mistake an identifier merely starting with 'git' for an invocation", () => {
		const source = `const GIT_MARKER = ".git";`;
		expect(findGitInvocationViolations("store/paths.ts", source)).toEqual([]);
	});

	it("does not mistake a command mentioned in prose for an invocation", () => {
		const source = `throw new Error('run "git init" first');`;
		expect(findGitInvocationViolations("app/initRepo.ts", source)).toEqual([]);
	});
});
