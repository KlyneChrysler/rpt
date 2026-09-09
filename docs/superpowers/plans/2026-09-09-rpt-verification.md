# rpt Verification and Gate Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a recorded run into an adjudicated one. rpt independently reruns tests, checks the diff against the agent's claims, scans for secrets and dependency risk, scores the change, blocks risky commits until a human approves, and attaches a portable attestation to the commit.

**Architecture:** Verifiers run against a detached git worktree built from the run's end snapshot, so the user's working tree and index are never involved and a concurrently editing agent cannot race the test run. Verifier output becomes `RunFacts`, a plain data structure. Risk scoring is a pure function of those facts and the configured policy. The commit gate is a git pre-commit hook whose exit code is the entire contract.

**Tech Stack:** Same as Plan 1. New runtime dependency: none. Optional external tools used when present on PATH: `gitleaks`.

**Spec:** `docs/superpowers/specs/2026-09-09-rpt-design.md`

**Depends on:** Plan 1, `docs/superpowers/plans/2026-09-09-rpt-recorder.md`. Every task below assumes Plan 1 is complete and its tests pass.

## Global Constraints

- All Plan 1 constraints continue to apply, including the domain purity guard and the 80 percent coverage floor.
- `src/risk/` is pure. It imports from `src/domain/` only, performs no I/O, and is covered by the purity guard test extended in Task 9.
- No verifier receives the user's working tree path. Verifiers see only the prepared worktree.
- A verifier that cannot run returns `skipped` with a reason. It never returns `passed`.
- Approval requires an interactive TTY. `rpt approve` and `rpt reject` are never exposed to an agent surface.
- rpt ships no secret-detection rules that would themselves contain a credential. Patterns match shapes, never literal known keys.

---

### Task 1: Verification worktree

**Files:**
- Create: `src/git/worktree.ts`
- Test: `test/git/worktree.test.ts`

**Interfaces:**
- Consumes: `git` from `src/git/exec.ts`, `refFor` from `src/git/snapshot.ts`
- Produces: `Worktree = { path: string; dispose(): Promise<void> }`; `openWorktree(repoRoot: string, sha: string): Promise<Worktree>`; `pruneWorktrees(repoRoot: string): Promise<string[]>`

- [ ] **Step 1: Write the failing worktree test**

`test/git/worktree.test.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "../../src/git/exec.js";
import { createSnapshot } from "../../src/git/snapshot.js";
import { openWorktree, pruneWorktrees } from "../../src/git/worktree.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

describe("openWorktree", () => {
	it("materialises the snapshot's file contents", async () => {
		const repo = await makeFixtureRepo();
		await writeFile(join(repo, "auth.ts"), "export const timeout = 5000;\n");
		const sha = await createSnapshot(repo, 1, "end");
		const worktree = await openWorktree(repo, sha);
		expect(await readFile(join(worktree.path, "auth.ts"), "utf8")).toContain("5000");
		await worktree.dispose();
	});

	it("is isolated from later edits in the original repo", async () => {
		const repo = await makeFixtureRepo();
		await writeFile(join(repo, "auth.ts"), "first\n");
		const worktree = await openWorktree(repo, await createSnapshot(repo, 1, "end"));
		await writeFile(join(repo, "auth.ts"), "second\n");
		expect(await readFile(join(worktree.path, "auth.ts"), "utf8")).toBe("first\n");
		await worktree.dispose();
	});

	it("removes itself on dispose", async () => {
		const repo = await makeFixtureRepo();
		const worktree = await openWorktree(repo, await createSnapshot(repo, 1, "end"));
		await worktree.dispose();
		expect(await git(repo, ["worktree", "list"])).not.toContain(worktree.path);
	});

	it("leaves the original checkout on its own branch", async () => {
		const repo = await makeFixtureRepo();
		const worktree = await openWorktree(repo, await createSnapshot(repo, 1, "end"));
		expect(await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
		await worktree.dispose();
	});
});

describe("pruneWorktrees", () => {
	it("reports nothing to clean in a fresh repo", async () => {
		expect(await pruneWorktrees(await makeFixtureRepo())).toEqual([]);
	});
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run test/git/worktree.test.ts`
Expected: FAIL, cannot resolve `../../src/git/worktree.js`.

- [ ] **Step 3: Write the worktree module**

`src/git/worktree.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./exec.js";

export type Worktree = { path: string; dispose(): Promise<void> };

export async function openWorktree(repoRoot: string, sha: string): Promise<Worktree> {
	const parent = await mkdtemp(join(tmpdir(), "rpt-wt-"));
	const path = join(parent, "tree");
	await git(repoRoot, ["worktree", "add", "--detach", "--quiet", path, sha]);
	return { path, dispose: () => dispose(repoRoot, parent, path) };
}

export async function pruneWorktrees(repoRoot: string): Promise<string[]> {
	const before = await listRptWorktrees(repoRoot);
	await git(repoRoot, ["worktree", "prune"]);
	const after = await listRptWorktrees(repoRoot);
	return before.filter((path) => !after.includes(path));
}

async function dispose(repoRoot: string, parent: string, path: string): Promise<void> {
	await git(repoRoot, ["worktree", "remove", "--force", path]);
	await rm(parent, { recursive: true, force: true });
}

async function listRptWorktrees(repoRoot: string): Promise<string[]> {
	const output = await git(repoRoot, ["worktree", "list", "--porcelain"]);
	return output
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length))
		.filter((path) => path.includes("rpt-wt-"));
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run test/git/worktree.test.ts`
Expected: PASS, five tests.

- [ ] **Step 5: Commit**

```bash
git add src/git/worktree.ts test/git/worktree.test.ts
git commit -m "feat: detached verification worktree isolated from the working tree"
```

---

### Task 2: Verifier contract and run context

**Files:**
- Create: `src/verifiers/Verifier.ts`
- Create: `src/app/runContext.ts`
- Test: `test/verifiers/contract.test.ts`

**Interfaces:**
- Consumes: `RptConfig`, `Claims`, `Worktree`
- Produces: `VerifierStatus = "passed" | "failed" | "skipped"`; `VerifierResult = { id: string; status: VerifierStatus; reason: string | null; facts: Record<string, unknown> }`; `RunContext = { repoRoot: string; worktree: string; baseSha: string; endSha: string; config: RptConfig; claims: Claims }`; `Verifier` interface; `runVerifiers(verifiers: Verifier[], context: RunContext): Promise<VerifierResult[]>`

- [ ] **Step 1: Write the failing contract test**

`test/verifiers/contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runVerifiers, type RunContext, type Verifier } from "../../src/verifiers/Verifier.js";
import { DEFAULT_CONFIG } from "../../src/config/load.js";

const context: RunContext = {
	repoRoot: "/repo",
	worktree: "/wt",
	baseSha: "a".repeat(40),
	endSha: "b".repeat(40),
	config: DEFAULT_CONFIG,
	claims: { mutatedPaths: [], commands: [] },
};

function verifier(id: string, run: Verifier["run"]): Verifier {
	return { id, run };
}

describe("runVerifiers", () => {
	it("returns one result per verifier, in order", async () => {
		const results = await runVerifiers(
			[
				verifier("a", async () => ({ id: "a", status: "passed", reason: null, facts: {} })),
				verifier("b", async () => ({ id: "b", status: "failed", reason: "nope", facts: {} })),
			],
			context,
		);
		expect(results.map((result) => result.id)).toEqual(["a", "b"]);
	});

	it("converts a thrown verifier into a skipped result carrying the message", async () => {
		const [result] = await runVerifiers(
			[verifier("boom", async () => { throw new Error("git exploded"); })],
			context,
		);
		expect(result?.status).toBe("skipped");
		expect(result?.reason).toContain("git exploded");
	});

	it("keeps running the remaining verifiers after one throws", async () => {
		const results = await runVerifiers(
			[
				verifier("boom", async () => { throw new Error("x"); }),
				verifier("ok", async () => ({ id: "ok", status: "passed", reason: null, facts: {} })),
			],
			context,
		);
		expect(results[1]?.status).toBe("passed");
	});

	it("rejects a verifier that returns skipped without a reason", async () => {
		await expect(
			runVerifiers([verifier("bad", async () => ({ id: "bad", status: "skipped", reason: null, facts: {} }))], context),
		).rejects.toThrow(/reason/i);
	});
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run test/verifiers/contract.test.ts`
Expected: FAIL, cannot resolve `../../src/verifiers/Verifier.js`.

- [ ] **Step 3: Write the contract**

`src/verifiers/Verifier.ts`:

```ts
import type { RptConfig } from "../config/schema.js";
import type { Claims } from "../domain/run.js";

export type VerifierStatus = "passed" | "failed" | "skipped";

export type VerifierResult = {
	id: string;
	status: VerifierStatus;
	reason: string | null;
	facts: Record<string, unknown>;
};

export type RunContext = {
	repoRoot: string;
	worktree: string;
	baseSha: string;
	endSha: string;
	config: RptConfig;
	claims: Claims;
};

export interface Verifier {
	readonly id: string;
	run(context: RunContext): Promise<VerifierResult>;
}

export async function runVerifiers(
	verifiers: readonly Verifier[],
	context: RunContext,
): Promise<VerifierResult[]> {
	const results: VerifierResult[] = [];
	for (const verifier of verifiers) results.push(await runOne(verifier, context));
	return results;
}

async function runOne(verifier: Verifier, context: RunContext): Promise<VerifierResult> {
	try {
		return assertExplained(await verifier.run(context));
	} catch (error) {
		return skipped(verifier.id, `verifier threw: ${(error as Error).message}`);
	}
}

function assertExplained(result: VerifierResult): VerifierResult {
	if (result.status !== "passed" && result.reason === null) {
		throw new Error(`verifier ${result.id} returned ${result.status} without a reason`);
	}
	return result;
}

export function skipped(id: string, reason: string): VerifierResult {
	return { id, status: "skipped", reason, facts: {} };
}

export function passed(id: string, facts: Record<string, unknown> = {}): VerifierResult {
	return { id, status: "passed", reason: null, facts };
}

export function failed(id: string, reason: string, facts: Record<string, unknown> = {}): VerifierResult {
	return { id, status: "failed", reason, facts };
}
```

Note the deliberate asymmetry: a verifier that throws becomes `skipped`, not `failed`. rpt failing to check something is not evidence that the thing is wrong. It is evidence that rpt does not know, and not knowing blocks VERIFIED.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run test/verifiers/contract.test.ts`
Expected: PASS, four tests.

- [ ] **Step 5: Commit**

```bash
git add src/verifiers/Verifier.ts test/verifiers/contract.test.ts
git commit -m "feat: verifier contract where an unrunnable check never reads as a pass"
```

---

### Task 3: Test verifier

**Files:**
- Create: `src/verifiers/detectTestCommand.ts`
- Create: `src/verifiers/TestVerifier.ts`
- Test: `test/verifiers/detectTestCommand.test.ts`
- Test: `test/verifiers/TestVerifier.test.ts`

**Interfaces:**
- Consumes: `RunContext`, `RptConfig`
- Produces: `detectTestCommand(worktree: string): Promise<string | null>`; `testVerifier: Verifier`

- [ ] **Step 1: Write the failing detection test**

`test/verifiers/detectTestCommand.test.ts`:

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectTestCommand } from "../../src/verifiers/detectTestCommand.js";

async function treeWith(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "rpt-detect-"));
	for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
	return dir;
}

describe("detectTestCommand", () => {
	it("uses the package.json test script when present", async () => {
		const dir = await treeWith({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });
		expect(await detectTestCommand(dir)).toBe("npm test");
	});

	it("prefers pnpm when a pnpm lockfile is present", async () => {
		const dir = await treeWith({
			"package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
			"pnpm-lock.yaml": "lockfileVersion: 9.0\n",
		});
		expect(await detectTestCommand(dir)).toBe("pnpm test");
	});

	it("detects go", async () => {
		expect(await detectTestCommand(await treeWith({ "go.mod": "module x\n" }))).toBe("go test ./...");
	});

	it("detects cargo", async () => {
		expect(await detectTestCommand(await treeWith({ "Cargo.toml": "[package]\n" }))).toBe("cargo test");
	});

	it("detects python projects that declare pytest", async () => {
		const dir = await treeWith({ "pyproject.toml": "[tool.pytest.ini_options]\n" });
		expect(await detectTestCommand(dir)).toBe("pytest");
	});

	it("returns null when nothing is recognisable", async () => {
		expect(await detectTestCommand(await treeWith({ "readme.txt": "hi" }))).toBeNull();
	});

	it("returns null for a package.json with no test script", async () => {
		const dir = await treeWith({ "package.json": JSON.stringify({ scripts: { build: "tsc" } }) });
		expect(await detectTestCommand(dir)).toBeNull();
	});
});
```

- [ ] **Step 2: Write the detector**

`src/verifiers/detectTestCommand.ts`:

```ts
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
```

- [ ] **Step 3: Run the detection test and confirm it passes**

Run: `pnpm vitest run test/verifiers/detectTestCommand.test.ts`
Expected: PASS, seven tests.

- [ ] **Step 4: Write the failing test verifier test**

`test/verifiers/TestVerifier.test.ts`:

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/load.js";
import { testVerifier } from "../../src/verifiers/TestVerifier.js";
import type { RunContext } from "../../src/verifiers/Verifier.js";

async function contextRunning(command: string | null): Promise<RunContext> {
	const worktree = await mkdtemp(join(tmpdir(), "rpt-tv-"));
	await writeFile(join(worktree, "marker"), "");
	return {
		repoRoot: worktree,
		worktree,
		baseSha: "a".repeat(40),
		endSha: "b".repeat(40),
		config: { ...DEFAULT_CONFIG, testCommand: command },
		claims: { mutatedPaths: [], commands: [] },
	};
}

describe("testVerifier", () => {
	it("passes when the configured command exits zero", async () => {
		const result = await testVerifier.run(await contextRunning("exit 0"));
		expect(result.status).toBe("passed");
	});

	it("fails when the command exits non-zero and keeps the tail of the output", async () => {
		const result = await testVerifier.run(await contextRunning("echo 'boom failure' >&2; exit 1"));
		expect(result.status).toBe("failed");
		expect(String(result.facts.output)).toContain("boom failure");
	});

	it("skips with a reason when no command can be resolved", async () => {
		const result = await testVerifier.run(await contextRunning(null));
		expect(result.status).toBe("skipped");
		expect(result.reason).toMatch(/no test command/i);
	});

	it("reports the command it actually ran", async () => {
		const result = await testVerifier.run(await contextRunning("exit 0"));
		expect(result.facts.command).toBe("exit 0");
	});

	it("parses pass and fail counts when the output states them", async () => {
		const result = await testVerifier.run(await contextRunning("echo '184 passed, 0 failed'; exit 0"));
		expect(result.facts.passed).toBe(184);
		expect(result.facts.failed).toBe(0);
	});

	it("records unknown counts rather than guessing when the output is silent", async () => {
		const result = await testVerifier.run(await contextRunning("exit 0"));
		expect(result.facts.passed).toBeNull();
	});
});
```

- [ ] **Step 5: Write the test verifier**

`src/verifiers/TestVerifier.ts`:

```ts
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { detectTestCommand } from "./detectTestCommand.js";
import { failed, passed, skipped, type RunContext, type Verifier, type VerifierResult } from "./Verifier.js";

const run = promisify(exec);
const TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL = 4000;

export const testVerifier: Verifier = {
	id: "tests",
	async run(context: RunContext): Promise<VerifierResult> {
		const command = context.config.testCommand ?? (await detectTestCommand(context.worktree));
		if (command === null) {
			return skipped("tests", "no test command configured and none could be detected");
		}
		const outcome = await execute(command, context.worktree);
		const facts = { command, ...countsFrom(outcome.output), output: tail(outcome.output) };
		return outcome.ok
			? passed("tests", facts)
			: failed("tests", `test command exited ${outcome.code}`, facts);
	},
};

type Outcome = { ok: boolean; code: number; output: string };

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
```

Counts are `null` when the reporter does not state them. A null count is honest; a zero would be a lie that the risk engine would then reward.

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm vitest run test/verifiers/TestVerifier.test.ts`
Expected: PASS, six tests.

- [ ] **Step 7: Commit**

```bash
git add src/verifiers/TestVerifier.ts src/verifiers/detectTestCommand.ts test/verifiers
git commit -m "feat: test verifier that reruns the suite rather than trusting the agent"
```

---

### Task 4: Diff integrity verifier

**Files:**
- Create: `src/verifiers/DiffIntegrityVerifier.ts`
- Test: `test/verifiers/DiffIntegrityVerifier.test.ts`

**Interfaces:**
- Consumes: `diffNameStatus`, `diffStat`, `RunContext`
- Produces: `diffIntegrityVerifier: Verifier`; facts `{ observedPaths, claimedPaths, undeclared, manifestChanged, added, removed }`

- [ ] **Step 1: Write the failing test**

`test/verifiers/DiffIntegrityVerifier.test.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/load.js";
import { createSnapshot } from "../../src/git/snapshot.js";
import { diffIntegrityVerifier } from "../../src/verifiers/DiffIntegrityVerifier.js";
import type { RunContext } from "../../src/verifiers/Verifier.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

async function contextAfter(
	writes: Record<string, string>,
	claimed: string[],
): Promise<RunContext> {
	const repo = await makeFixtureRepo();
	const baseSha = await createSnapshot(repo, 1, "base");
	for (const [path, body] of Object.entries(writes)) await writeFile(join(repo, path), body);
	const endSha = await createSnapshot(repo, 1, "end");
	return {
		repoRoot: repo,
		worktree: repo,
		baseSha,
		endSha,
		config: DEFAULT_CONFIG,
		claims: { mutatedPaths: claimed, commands: [] },
	};
}

describe("diffIntegrityVerifier", () => {
	it("passes when claims and observations agree", async () => {
		const result = await diffIntegrityVerifier.run(await contextAfter({ "a.ts": "1\n" }, ["a.ts"]));
		expect(result.status).toBe("passed");
	});

	it("fails and names files the agent never declared", async () => {
		const result = await diffIntegrityVerifier.run(
			await contextAfter({ "a.ts": "1\n", ".env.local": "SECRET=1\n" }, ["a.ts"]),
		);
		expect(result.status).toBe("failed");
		expect(result.facts.undeclared).toEqual([".env.local"]);
	});

	it("tolerates a claim for a file that ended up unchanged", async () => {
		const result = await diffIntegrityVerifier.run(await contextAfter({ "a.ts": "1\n" }, ["a.ts", "b.ts"]));
		expect(result.status).toBe("passed");
	});

	it("flags a manifest change separately from failing", async () => {
		const result = await diffIntegrityVerifier.run(
			await contextAfter({ "package-lock.json": "{}\n" }, ["package-lock.json"]),
		);
		expect(result.facts.manifestChanged).toBe(true);
		expect(result.status).toBe("passed");
	});

	it("counts added and removed lines", async () => {
		const result = await diffIntegrityVerifier.run(await contextAfter({ "a.ts": "1\n2\n3\n" }, ["a.ts"]));
		expect(result.facts.added).toBe(3);
	});

	it("passes on an empty diff with an empty claim", async () => {
		const result = await diffIntegrityVerifier.run(await contextAfter({}, []));
		expect(result.status).toBe("passed");
		expect(result.facts.observedPaths).toEqual([]);
	});
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run test/verifiers/DiffIntegrityVerifier.test.ts`
Expected: FAIL, module unresolved.

- [ ] **Step 3: Write the verifier**

`src/verifiers/DiffIntegrityVerifier.ts`:

```ts
import { diffNameStatus, diffStat } from "../git/diff.js";
import { failed, passed, type RunContext, type Verifier, type VerifierResult } from "./Verifier.js";

const MANIFESTS = [
	"package.json",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lockb",
	"go.mod",
	"go.sum",
	"Cargo.toml",
	"Cargo.lock",
	"pyproject.toml",
	"requirements.txt",
	"poetry.lock",
	"Gemfile.lock",
];

export const diffIntegrityVerifier: Verifier = {
	id: "diff-integrity",
	async run(context: RunContext): Promise<VerifierResult> {
		const entries = await diffNameStatus(context.repoRoot, context.baseSha, context.endSha);
		const observedPaths = entries.map((entry) => entry.path);
		const claimed = new Set(context.claims.mutatedPaths);
		const undeclared = observedPaths.filter((path) => !claimed.has(path));
		const { added, removed } = await diffStat(context.repoRoot, context.baseSha, context.endSha);
		const facts = {
			observedPaths,
			claimedPaths: context.claims.mutatedPaths,
			undeclared,
			manifestChanged: observedPaths.some(isManifest),
			added,
			removed,
		};
		if (undeclared.length === 0) return passed("diff-integrity", facts);
		return failed(
			"diff-integrity",
			`${undeclared.length} file(s) changed that the agent never declared: ${undeclared.join(", ")}`,
			facts,
		);
	},
};

function isManifest(path: string): boolean {
	const name = path.split("/").pop() ?? path;
	return MANIFESTS.includes(name);
}
```

A claimed file that ended up unchanged is not a failure. Agents routinely write a file and then revert it. The asymmetry is intentional: undeclared changes are the risk, unfulfilled claims are noise.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run test/verifiers/DiffIntegrityVerifier.test.ts`
Expected: PASS, six tests.

- [ ] **Step 5: Commit**

```bash
git add src/verifiers/DiffIntegrityVerifier.ts test/verifiers/DiffIntegrityVerifier.test.ts
git commit -m "feat: diff integrity verifier that catches undeclared changes"
```

---

### Task 5: Security verifier

**Files:**
- Create: `src/verifiers/secretPatterns.ts`
- Create: `src/verifiers/scanSecrets.ts`
- Create: `src/verifiers/SecurityVerifier.ts`
- Test: `test/verifiers/scanSecrets.test.ts`
- Test: `test/verifiers/SecurityVerifier.test.ts`

**Interfaces:**
- Consumes: `diffPatch`, `RunContext`
- Produces: `SecretFinding = { rule: string; path: string; line: number }`; `scanSecrets(patch: string): SecretFinding[]`; `securityVerifier: Verifier`

- [ ] **Step 1: Write the failing secret scan test**

`test/verifiers/scanSecrets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { scanSecrets } from "../../src/verifiers/scanSecrets.js";

function patch(...addedLines: string[]): string {
	return ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", ...addedLines.map((line) => `+${line}`)].join("\n");
}

describe("scanSecrets", () => {
	it("finds a private key header", () => {
		const findings = scanSecrets(patch("-----BEGIN RSA PRIVATE KEY-----"));
		expect(findings[0]?.rule).toBe("private-key");
	});

	it("finds an assignment of a long high-entropy string to a secret-looking name", () => {
		const findings = scanSecrets(patch('const apiSecret = "Zq7Xk29fLp03Ta6BvNc81WdYh4Rj5MgS";'));
		expect(findings[0]?.rule).toBe("high-entropy-assignment");
	});

	it("ignores a low-entropy assignment even to a secret-looking name", () => {
		expect(scanSecrets(patch('const apiSecret = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";'))).toEqual([]);
	});

	it("ignores an obvious placeholder", () => {
		expect(scanSecrets(patch('const apiSecret = "your-api-key-here";'))).toEqual([]);
	});

	it("ignores removed lines", () => {
		const removal = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "-----BEGIN RSA PRIVATE KEY-----"].join("\n");
		expect(scanSecrets(removal)).toEqual([]);
	});

	it("reports the file the finding came from", () => {
		expect(scanSecrets(patch("-----BEGIN RSA PRIVATE KEY-----"))[0]?.path).toBe("x.ts");
	});

	it("finds nothing in an ordinary code change", () => {
		expect(scanSecrets(patch("export const timeout = AUTHENTICATION_TIMEOUT_MS;"))).toEqual([]);
	});
});
```

- [ ] **Step 2: Write the scanner**

`src/verifiers/secretPatterns.ts`:

```ts
export type SecretPattern = { rule: string; test: RegExp };

export const SECRET_PATTERNS: readonly SecretPattern[] = [
	{ rule: "private-key", test: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ rule: "aws-access-key-id", test: /\bAKIA[0-9A-Z]{16}\b/ },
	{ rule: "bearer-token", test: /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}/i },
	{ rule: "url-credentials", test: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/i },
];

export const SECRET_NAME = /\b(secret|token|password|passwd|api[_-]?key|private[_-]?key|credential)\b/i;

export const PLACEHOLDER =
	/(your|example|sample|dummy|placeholder|changeme|xxxx|redacted|<[^>]+>|\.\.\.)/i;
```

Patterns match shapes only. No real credential appears in this file or its tests.

`src/verifiers/scanSecrets.ts`:

```ts
import { PLACEHOLDER, SECRET_NAME, SECRET_PATTERNS } from "./secretPatterns.js";

export type SecretFinding = { rule: string; path: string; line: number };

const MIN_SECRET_LENGTH = 20;
const MIN_ENTROPY_BITS_PER_CHAR = 3.5;

export function scanSecrets(patch: string): SecretFinding[] {
	const findings: SecretFinding[] = [];
	let path = "unknown";
	let line = 0;
	for (const raw of patch.split("\n")) {
		if (raw.startsWith("+++ b/")) {
			path = raw.slice("+++ b/".length);
			line = 0;
			continue;
		}
		if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
		line += 1;
		findings.push(...findingsIn(raw.slice(1), path, line));
	}
	return findings;
}

function findingsIn(content: string, path: string, line: number): SecretFinding[] {
	const matched = SECRET_PATTERNS.filter((pattern) => pattern.test.test(content));
	const rules = matched.map((pattern) => pattern.rule);
	if (looksLikeSecretAssignment(content)) rules.push("high-entropy-assignment");
	return rules.map((rule) => ({ rule, path, line }));
}

function looksLikeSecretAssignment(content: string): boolean {
	if (!SECRET_NAME.test(content)) return false;
	const literal = /["'`]([^"'`]{20,})["'`]/.exec(content)?.[1];
	if (literal === undefined || PLACEHOLDER.test(literal)) return false;
	return literal.length >= MIN_SECRET_LENGTH && shannonBits(literal) >= MIN_ENTROPY_BITS_PER_CHAR;
}

function shannonBits(value: string): number {
	const counts = new Map<string, number>();
	for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
	return [...counts.values()].reduce((bits, count) => {
		const probability = count / value.length;
		return bits - probability * Math.log2(probability);
	}, 0);
}
```

- [ ] **Step 3: Run the scan test and confirm it passes**

Run: `pnpm vitest run test/verifiers/scanSecrets.test.ts`
Expected: PASS, seven tests.

- [ ] **Step 4: Write the failing security verifier test**

`test/verifiers/SecurityVerifier.test.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/load.js";
import { createSnapshot } from "../../src/git/snapshot.js";
import { securityVerifier } from "../../src/verifiers/SecurityVerifier.js";
import type { RunContext } from "../../src/verifiers/Verifier.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

async function contextAfter(writes: Record<string, string>): Promise<RunContext> {
	const repo = await makeFixtureRepo();
	const baseSha = await createSnapshot(repo, 1, "base");
	for (const [path, body] of Object.entries(writes)) await writeFile(join(repo, path), body);
	const endSha = await createSnapshot(repo, 1, "end");
	return {
		repoRoot: repo,
		worktree: repo,
		baseSha,
		endSha,
		config: DEFAULT_CONFIG,
		claims: { mutatedPaths: Object.keys(writes), commands: [] },
	};
}

describe("securityVerifier", () => {
	it("passes a clean change", async () => {
		const result = await securityVerifier.run(await contextAfter({ "a.ts": "export const a = 1;\n" }));
		expect(result.status).toBe("passed");
		expect(result.facts.secretFindings).toEqual([]);
	});

	it("fails when a private key is introduced", async () => {
		const result = await securityVerifier.run(
			await contextAfter({ "key.pem": "-----BEGIN RSA PRIVATE KEY-----\nabc\n" }),
		);
		expect(result.status).toBe("failed");
		expect(result.reason).toMatch(/secret/i);
	});

	it("records that the dependency audit was skipped when no manifest changed", async () => {
		const result = await securityVerifier.run(await contextAfter({ "a.ts": "export const a = 1;\n" }));
		expect(result.facts.audit).toBe("not-applicable");
	});

	it("never reports the secret's value in its reason", async () => {
		const result = await securityVerifier.run(
			await contextAfter({ "x.ts": 'const apiSecret = "Zq7Xk29fLp03Ta6BvNc81WdYh4Rj5MgS";\n' }),
		);
		expect(result.reason).not.toContain("Zq7Xk29");
	});
});
```

- [ ] **Step 5: Write the security verifier**

`src/verifiers/SecurityVerifier.ts`:

```ts
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { diffNameStatus, diffPatch } from "../git/diff.js";
import { scanSecrets, type SecretFinding } from "./scanSecrets.js";
import { failed, passed, type RunContext, type Verifier, type VerifierResult } from "./Verifier.js";

const run = promisify(exec);
const AUDIT_TIMEOUT_MS = 90 * 1000;

type AuditOutcome = "clean" | "findings" | "skipped" | "not-applicable";

export const securityVerifier: Verifier = {
	id: "security",
	async run(context: RunContext): Promise<VerifierResult> {
		const patch = await diffPatch(context.repoRoot, context.baseSha, context.endSha);
		const secretFindings = scanSecrets(patch);
		const audit = await auditIfManifestChanged(context);
		const facts = { secretFindings, audit };
		if (secretFindings.length > 0) {
			return failed("security", `${secretFindings.length} possible secret(s): ${describe(secretFindings)}`, facts);
		}
		if (audit === "findings") return failed("security", "dependency audit reported high severity findings", facts);
		return passed("security", facts);
	},
};

function describe(findings: readonly SecretFinding[]): string {
	return findings.map((finding) => `${finding.rule} at ${finding.path}:${finding.line}`).join(", ");
}

async function auditIfManifestChanged(context: RunContext): Promise<AuditOutcome> {
	const entries = await diffNameStatus(context.repoRoot, context.baseSha, context.endSha);
	const changed = entries.some((entry) => entry.path.endsWith("package.json") || entry.path.includes("lock"));
	if (!changed) return "not-applicable";
	return runAudit(context.worktree);
}

async function runAudit(worktree: string): Promise<AuditOutcome> {
	try {
		await run("npm audit --audit-level=high", { cwd: worktree, timeout: AUDIT_TIMEOUT_MS });
		return "clean";
	} catch (error) {
		const failure = error as { code?: number; stderr?: string };
		if (failure.code === 1) return "findings";
		return "skipped";
	}
}
```

The reason string names the rule and location, never the matched value. Printing a discovered credential into a log, a note or a terminal would spread the exposure rpt exists to catch.

An audit that cannot run, offline for example, returns `skipped`, which the risk engine penalises rather than rewards.

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm vitest run test/verifiers/SecurityVerifier.test.ts`
Expected: PASS, four tests.

- [ ] **Step 7: Commit**

```bash
git add src/verifiers/SecurityVerifier.ts src/verifiers/scanSecrets.ts src/verifiers/secretPatterns.ts test/verifiers
git commit -m "feat: security verifier for secrets and dependency audit"
```

---

### Task 6: Test quality verifier

**Files:**
- Create: `src/verifiers/lcov.ts`
- Create: `src/verifiers/TestQualityVerifier.ts`
- Test: `test/verifiers/lcov.test.ts`
- Test: `test/verifiers/TestQualityVerifier.test.ts`

**Interfaces:**
- Consumes: `diffNameStatus`, `RunContext`
- Produces: `parseLcov(body: string): Map<string, Set<number>>`; `changedLines(repoRoot, baseSha, endSha): Promise<Map<string, Set<number>>>`; `testQualityVerifier: Verifier`; facts `{ changeCoverage, changedLineCount, coveredLineCount }`

- [ ] **Step 1: Write the failing lcov test**

`test/verifiers/lcov.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseLcov } from "../../src/verifiers/lcov.js";

const body = ["SF:src/auth.ts", "DA:1,3", "DA:2,0", "DA:3,7", "end_of_record", "SF:src/db.ts", "DA:1,1", "end_of_record"].join("\n");

describe("parseLcov", () => {
	it("collects executed lines per file", () => {
		expect([...(parseLcov(body).get("src/auth.ts") ?? [])]).toEqual([1, 3]);
	});

	it("excludes lines with a zero hit count", () => {
		expect(parseLcov(body).get("src/auth.ts")?.has(2)).toBe(false);
	});

	it("handles multiple records", () => {
		expect(parseLcov(body).size).toBe(2);
	});

	it("returns an empty map for empty input", () => {
		expect(parseLcov("").size).toBe(0);
	});
});
```

- [ ] **Step 2: Write the lcov parser and changed-line extractor**

`src/verifiers/lcov.ts`:

```ts
import { git } from "../git/exec.js";

export function parseLcov(body: string): Map<string, Set<number>> {
	const covered = new Map<string, Set<number>>();
	let file: string | null = null;
	for (const line of body.split("\n")) {
		if (line.startsWith("SF:")) {
			file = line.slice(3).trim();
			covered.set(file, new Set());
			continue;
		}
		if (file === null || !line.startsWith("DA:")) continue;
		const [number = "0", hits = "0"] = line.slice(3).split(",");
		if (Number(hits) > 0) covered.get(file)?.add(Number(number));
	}
	return covered;
}

export async function changedLines(
	repoRoot: string,
	baseSha: string,
	endSha: string,
): Promise<Map<string, Set<number>>> {
	const patch = await git(repoRoot, ["diff", "--unified=0", baseSha, endSha]);
	const changed = new Map<string, Set<number>>();
	let file: string | null = null;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+++ b/")) {
			file = line.slice("+++ b/".length);
			changed.set(file, new Set());
			continue;
		}
		if (file === null || !line.startsWith("@@")) continue;
		for (const number of hunkLines(line)) changed.get(file)?.add(number);
	}
	return changed;
}

function hunkLines(header: string): number[] {
	const match = /\+(\d+)(?:,(\d+))?/.exec(header);
	if (match === null) return [];
	const start = Number(match[1]);
	const count = match[2] === undefined ? 1 : Number(match[2]);
	return Array.from({ length: count }, (_, offset) => start + offset);
}
```

- [ ] **Step 3: Write the failing quality verifier test**

`test/verifiers/TestQualityVerifier.test.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/load.js";
import { createSnapshot } from "../../src/git/snapshot.js";
import { testQualityVerifier } from "../../src/verifiers/TestQualityVerifier.js";
import type { RunContext } from "../../src/verifiers/Verifier.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

async function contextWith(options: { coverageCommand: string | null; lcov?: string }): Promise<RunContext> {
	const repo = await makeFixtureRepo();
	const baseSha = await createSnapshot(repo, 1, "base");
	await writeFile(join(repo, "auth.ts"), "line1\nline2\nline3\n");
	const endSha = await createSnapshot(repo, 1, "end");
	if (options.lcov !== undefined) {
		await mkdir(join(repo, "coverage"), { recursive: true });
		await writeFile(join(repo, "coverage", "lcov.info"), options.lcov);
	}
	return {
		repoRoot: repo,
		worktree: repo,
		baseSha,
		endSha,
		config: { ...DEFAULT_CONFIG, coverageCommand: options.coverageCommand },
		claims: { mutatedPaths: ["auth.ts"], commands: [] },
	};
}

describe("testQualityVerifier", () => {
	it("skips with a reason when no coverage command is configured", async () => {
		const result = await testQualityVerifier.run(await contextWith({ coverageCommand: null }));
		expect(result.status).toBe("skipped");
		expect(result.reason).toMatch(/coverage/i);
	});

	it("skips when the coverage run produced no lcov file", async () => {
		const result = await testQualityVerifier.run(await contextWith({ coverageCommand: "true" }));
		expect(result.status).toBe("skipped");
	});

	it("reports the fraction of changed lines that tests executed", async () => {
		const lcov = ["SF:auth.ts", "DA:1,1", "DA:2,1", "DA:3,0", "end_of_record"].join("\n");
		const result = await testQualityVerifier.run(await contextWith({ coverageCommand: "true", lcov }));
		expect(result.facts.changeCoverage).toBeCloseTo(2 / 3, 5);
	});

	it("passes when coverage of the change is complete", async () => {
		const lcov = ["SF:auth.ts", "DA:1,1", "DA:2,1", "DA:3,1", "end_of_record"].join("\n");
		const result = await testQualityVerifier.run(await contextWith({ coverageCommand: "true", lcov }));
		expect(result.status).toBe("passed");
	});
});
```

- [ ] **Step 4: Write the verifier**

`src/verifiers/TestQualityVerifier.ts`:

```ts
import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { changedLines, parseLcov } from "./lcov.js";
import { failed, passed, skipped, type RunContext, type Verifier, type VerifierResult } from "./Verifier.js";

const run = promisify(exec);
const TIMEOUT_MS = 10 * 60 * 1000;
const MIN_CHANGE_COVERAGE = 0.5;

export const testQualityVerifier: Verifier = {
	id: "test-quality",
	async run(context: RunContext): Promise<VerifierResult> {
		if (context.config.verifiers.testQuality === "off") return skipped("test-quality", "disabled in config");
		const command = context.config.coverageCommand;
		if (command === null) return skipped("test-quality", "no coverage command configured");
		await runQuietly(command, context.worktree);
		const lcov = await readLcov(context.worktree);
		if (lcov === null) return skipped("test-quality", "coverage run produced no coverage/lcov.info");
		return judge(context, lcov);
	},
};

async function judge(context: RunContext, lcov: string): Promise<VerifierResult> {
	const covered = parseLcov(lcov);
	const changed = await changedLines(context.repoRoot, context.baseSha, context.endSha);
	const totals = tally(changed, covered);
	if (totals.changedLineCount === 0) return passed("test-quality", { ...totals, changeCoverage: null });
	const changeCoverage = totals.coveredLineCount / totals.changedLineCount;
	const facts = { ...totals, changeCoverage };
	if (changeCoverage >= MIN_CHANGE_COVERAGE || context.config.verifiers.testQuality === "warn") {
		return passed("test-quality", facts);
	}
	return failed("test-quality", `tests executed only ${Math.round(changeCoverage * 100)}% of changed lines`, facts);
}

function tally(
	changed: Map<string, Set<number>>,
	covered: Map<string, Set<number>>,
): { changedLineCount: number; coveredLineCount: number } {
	let changedLineCount = 0;
	let coveredLineCount = 0;
	for (const [file, lines] of changed) {
		const hits = covered.get(file) ?? new Set<number>();
		changedLineCount += lines.size;
		for (const line of lines) if (hits.has(line)) coveredLineCount += 1;
	}
	return { changedLineCount, coveredLineCount };
}

async function runQuietly(command: string, cwd: string): Promise<void> {
	try {
		await run(command, { cwd, timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
	} catch {
		return;
	}
}

async function readLcov(worktree: string): Promise<string | null> {
	try {
		return await readFile(join(worktree, "coverage", "lcov.info"), "utf8");
	} catch {
		return null;
	}
}
```

`runQuietly` ignores the coverage command's exit status on purpose. The test verifier already owns the pass or fail judgement; this verifier only needs the artefact. A missing artefact becomes `skipped`, which is visible.

- [ ] **Step 5: Run both tests and confirm they pass**

Run: `pnpm vitest run test/verifiers/lcov.test.ts test/verifiers/TestQualityVerifier.test.ts`
Expected: PASS, eight tests.

- [ ] **Step 6: Commit**

```bash
git add src/verifiers/TestQualityVerifier.ts src/verifiers/lcov.ts test/verifiers
git commit -m "feat: test quality verifier measuring coverage of changed lines"
```

---

### Task 7: verifyRun use case

**Files:**
- Create: `src/domain/verdict.ts`
- Create: `src/app/verifyRun.ts`
- Test: `test/domain/verdict.test.ts`
- Test: `test/app/verifyRun.test.ts`

**Interfaces:**
- Consumes: all four verifiers, `openWorktree`, `loadRun`, `upsertRun`, `appendEvent`
- Produces: `VerdictName = "VERIFIED" | "FAILED" | "UNVERIFIED"`; `decideVerdict(results: VerifierResult[], hasGaps: boolean): VerdictName`; `Verdict = { runId; name; results; decidedAt }`; `verifyRun(repoRoot: string, runId: RunId): Promise<Verdict>`; `readVerdict(repoRoot, runId): Promise<Verdict | null>`

- [ ] **Step 1: Write the failing verdict test**

`test/domain/verdict.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decideVerdict } from "../../src/domain/verdict.js";
import type { VerifierResult } from "../../src/verifiers/Verifier.js";

function result(id: string, status: VerifierResult["status"]): VerifierResult {
	return { id, status, reason: status === "passed" ? null : "because", facts: {} };
}

describe("decideVerdict", () => {
	it("is VERIFIED when every verifier passed and there are no gaps", () => {
		expect(decideVerdict([result("a", "passed"), result("b", "passed")], false)).toBe("VERIFIED");
	});

	it("is FAILED when any verifier failed", () => {
		expect(decideVerdict([result("a", "passed"), result("b", "failed")], false)).toBe("FAILED");
	});

	it("prefers FAILED over UNVERIFIED when both a failure and a skip are present", () => {
		expect(decideVerdict([result("a", "failed"), result("b", "skipped")], false)).toBe("FAILED");
	});

	it("is UNVERIFIED when a verifier was skipped", () => {
		expect(decideVerdict([result("a", "passed"), result("b", "skipped")], false)).toBe("UNVERIFIED");
	});

	it("is UNVERIFIED when the log has gaps even though everything passed", () => {
		expect(decideVerdict([result("a", "passed")], true)).toBe("UNVERIFIED");
	});

	it("is UNVERIFIED when no verifier ran at all", () => {
		expect(decideVerdict([], false)).toBe("UNVERIFIED");
	});
});
```

- [ ] **Step 2: Write the verdict rule**

`src/domain/verdict.ts`:

```ts
import type { VerifierResult } from "../verifiers/Verifier.js";
import type { RunId } from "./events.js";

export type VerdictName = "VERIFIED" | "FAILED" | "UNVERIFIED";

export type Verdict = {
	runId: RunId;
	name: VerdictName;
	results: VerifierResult[];
	decidedAt: string;
};

export function decideVerdict(results: readonly VerifierResult[], hasGaps: boolean): VerdictName {
	if (results.some((result) => result.status === "failed")) return "FAILED";
	if (hasGaps || results.length === 0) return "UNVERIFIED";
	if (results.some((result) => result.status === "skipped")) return "UNVERIFIED";
	return "VERIFIED";
}
```

`src/domain/verdict.ts` imports a type from `src/verifiers/`. Extend the purity guard's allowed list to permit type-only imports, or move `VerifierResult` into `src/domain/` and have `src/verifiers/Verifier.ts` re-export it. Prefer the move: the verdict rule is domain logic and should own its input type.

- [ ] **Step 3: Write the failing verifyRun test**

`test/app/verifyRun.test.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initRepo } from "../../src/app/initRepo.js";
import { loadRun } from "../../src/app/loadRun.js";
import { readVerdict, verifyRun } from "../../src/app/verifyRun.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

async function repoWithRun(files: Record<string, string>, claimed: string[]): Promise<string> {
	const repo = await makeFixtureRepo();
	await initRepo(repo);
	await writeFile(join(repo, "rpt.config.json"), JSON.stringify({ testCommand: "exit 0" }));
	await driveFakeAgent(repo, [
		{ kind: "start", transcriptPath: null },
		...claimed.map((path) => ({ kind: "edit" as const, path, body: files[path] ?? "" })),
		{ kind: "stop" },
	]);
	return repo;
}

describe("verifyRun", () => {
	it("returns UNVERIFIED when a verifier had to skip", async () => {
		const repo = await repoWithRun({ "a.ts": "1\n" }, ["a.ts"]);
		const verdict = await verifyRun(repo, 1);
		expect(verdict.name).toBe("UNVERIFIED");
		expect(verdict.results.find((result) => result.id === "test-quality")?.status).toBe("skipped");
	});

	it("records the verdict so it can be read back", async () => {
		const repo = await repoWithRun({ "a.ts": "1\n" }, ["a.ts"]);
		await verifyRun(repo, 1);
		expect((await readVerdict(repo, 1))?.name).toBe("UNVERIFIED");
	});

	it("moves the run out of ENDED", async () => {
		const repo = await repoWithRun({ "a.ts": "1\n" }, ["a.ts"]);
		await verifyRun(repo, 1);
		expect((await loadRun(repo, 1)).state).not.toBe("ENDED");
	});

	it("fails the run when an undeclared file is present", async () => {
		const repo = await repoWithRun({ "a.ts": "1\n" }, ["a.ts"]);
		await writeFile(join(repo, "sneaky.ts"), "1\n");
		const { endRun } = await import("../../src/app/endRun.js");
		await expect(endRun(repo)).rejects.toThrow();
		expect((await verifyRun(repo, 1)).name).toBe("UNVERIFIED");
	});

	it("leaves no worktree behind", async () => {
		const repo = await repoWithRun({ "a.ts": "1\n" }, ["a.ts"]);
		await verifyRun(repo, 1);
		const { git } = await import("../../src/git/exec.js");
		expect(await git(repo, ["worktree", "list"])).not.toContain("rpt-wt-");
	});
});
```

- [ ] **Step 4: Write verifyRun**

`src/app/verifyRun.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config/load.js";
import type { RunId } from "../domain/events.js";
import { decideVerdict, type Verdict } from "../domain/verdict.js";
import { openWorktree } from "../git/worktree.js";
import { appendEvent } from "../store/eventLog.js";
import { rptDirOf, runDirOf } from "../store/paths.js";
import { upsertRun } from "../store/runIndex.js";
import { diffIntegrityVerifier } from "../verifiers/DiffIntegrityVerifier.js";
import { securityVerifier } from "../verifiers/SecurityVerifier.js";
import { testQualityVerifier } from "../verifiers/TestQualityVerifier.js";
import { testVerifier } from "../verifiers/TestVerifier.js";
import { runVerifiers, type RunContext } from "../verifiers/Verifier.js";
import { loadRun } from "./loadRun.js";

const VERIFIERS = [testVerifier, diffIntegrityVerifier, securityVerifier, testQualityVerifier];

export async function verifyRun(repoRoot: string, runId: RunId): Promise<Verdict> {
	const run = await loadRun(repoRoot, runId);
	if (run.baseSha === null || run.endSha === null) {
		throw new Error(`run ${runId} has no sealed end state, so it cannot be verified`);
	}
	const rptDir = rptDirOf(repoRoot);
	await appendEvent(rptDir, runId, marker("VerificationStarted", {}));
	await upsertRun(rptDir, { id: runId, task: run.task, state: "VERIFYING", startedAt: run.startedAt, endedAt: run.endedAt });

	const worktree = await openWorktree(repoRoot, run.endSha);
	try {
		const context: RunContext = {
			repoRoot,
			worktree: worktree.path,
			baseSha: run.baseSha,
			endSha: run.endSha,
			config: await loadConfig(repoRoot),
			claims: run.claims,
		};
		const results = await runVerifiers(VERIFIERS, context);
		for (const result of results) await appendEvent(rptDir, runId, marker("VerifierCompleted", { ...result }));
		const verdict: Verdict = {
			runId,
			name: decideVerdict(results, run.hasGaps),
			results,
			decidedAt: new Date().toISOString(),
		};
		await writeVerdict(repoRoot, verdict);
		await upsertRun(rptDir, { id: runId, task: run.task, state: verdict.name, startedAt: run.startedAt, endedAt: run.endedAt });
		return verdict;
	} finally {
		await worktree.dispose();
	}
}

export async function readVerdict(repoRoot: string, runId: RunId): Promise<Verdict | null> {
	try {
		return JSON.parse(await readFile(verdictPath(repoRoot, runId), "utf8")) as Verdict;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function writeVerdict(repoRoot: string, verdict: Verdict): Promise<void> {
	await writeFile(verdictPath(repoRoot, verdict.runId), `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
}

function verdictPath(repoRoot: string, runId: RunId): string {
	return join(runDirOf(rptDirOf(repoRoot), runId), "verdict.json");
}

function marker(kind: "VerificationStarted" | "VerifierCompleted", payload: Record<string, unknown>) {
	return { ts: new Date().toISOString(), source: "rpt" as const, kind, payload };
}
```

The worktree is disposed in a `finally`. A verifier crash must not leak a worktree, or the next run's `git worktree add` fails for an unrelated reason.

- [ ] **Step 5: Extend the run projection**

Add `VerificationStarted` and `VerifierCompleted` handling to `apply` in `src/domain/run.ts` so the projected state follows the index. Use `transition` so an illegal order still throws.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm vitest run test/domain/verdict.test.ts test/app/verifyRun.test.ts`
Expected: PASS, eleven tests.

- [ ] **Step 7: Commit**

```bash
git add src/domain/verdict.ts src/app/verifyRun.ts src/domain/run.ts test/domain/verdict.test.ts test/app/verifyRun.test.ts
git commit -m "feat: verifyRun orchestration with worktree isolation and recorded verdicts"
```

---

### Task 8: Run facts

**Files:**
- Create: `src/risk/facts.ts`
- Test: `test/risk/facts.test.ts`

**Interfaces:**
- Consumes: `VerifierResult`, `RptConfig`
- Produces: `RunFacts`; `buildFacts(results: VerifierResult[], config: RptConfig): RunFacts`

- [ ] **Step 1: Write the failing facts test**

`test/risk/facts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/load.js";
import { buildFacts } from "../../src/risk/facts.js";
import type { VerifierResult } from "../../src/domain/verdict.js";

function diffResult(facts: Record<string, unknown>): VerifierResult {
	return { id: "diff-integrity", status: "passed", reason: null, facts };
}

const emptyDiff = diffResult({ observedPaths: [], undeclared: [], manifestChanged: false, added: 0, removed: 0 });

describe("buildFacts", () => {
	it("counts files, additions and removals from the diff verifier", () => {
		const facts = buildFacts([diffResult({ observedPaths: ["a.ts", "b.ts"], undeclared: [], manifestChanged: false, added: 10, removed: 4 })], DEFAULT_CONFIG);
		expect(facts.fileCount).toBe(2);
		expect(facts.linesAdded).toBe(10);
		expect(facts.linesRemoved).toBe(4);
	});

	it("matches sensitive paths by configured category", () => {
		const facts = buildFacts([diffResult({ observedPaths: ["src/auth/pool.ts", "src/db/migrations/1.sql"], undeclared: [], manifestChanged: false, added: 1, removed: 0 })], DEFAULT_CONFIG);
		expect(facts.sensitiveMatches.map((match) => match.category).sort()).toEqual(["auth", "database"]);
	});

	it("reports no sensitive match for ordinary paths", () => {
		const facts = buildFacts([diffResult({ observedPaths: ["src/ui/Button.tsx"], undeclared: [], manifestChanged: false, added: 1, removed: 0 })], DEFAULT_CONFIG);
		expect(facts.sensitiveMatches).toEqual([]);
	});

	it("carries undeclared files through", () => {
		const facts = buildFacts([diffResult({ observedPaths: ["a.ts"], undeclared: ["a.ts"], manifestChanged: false, added: 1, removed: 0 })], DEFAULT_CONFIG);
		expect(facts.undeclaredFiles).toEqual(["a.ts"]);
	});

	it("maps a passing test verifier to a passed result", () => {
		const tests: VerifierResult = { id: "tests", status: "passed", reason: null, facts: { passed: 184, failed: 0 } };
		expect(buildFacts([emptyDiff, tests], DEFAULT_CONFIG).testResult).toBe("passed");
	});

	it("maps a skipped test verifier to unknown rather than passed", () => {
		const tests: VerifierResult = { id: "tests", status: "skipped", reason: "none found", facts: {} };
		expect(buildFacts([emptyDiff, tests], DEFAULT_CONFIG).testResult).toBe("unknown");
	});

	it("maps a skipped security verifier to a skipped scan result", () => {
		const security: VerifierResult = { id: "security", status: "skipped", reason: "offline", facts: {} };
		expect(buildFacts([emptyDiff, security], DEFAULT_CONFIG).scanResult).toBe("skipped");
	});

	it("reports null change coverage when the quality verifier could not measure it", () => {
		expect(buildFacts([emptyDiff], DEFAULT_CONFIG).changeCoverage).toBeNull();
	});

	it("counts added test files", () => {
		const facts = buildFacts([diffResult({ observedPaths: ["src/a.ts", "test/a.test.ts", "src/b_test.go"], undeclared: [], manifestChanged: false, added: 1, removed: 0 })], DEFAULT_CONFIG);
		expect(facts.testsAdded).toBe(2);
	});
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run test/risk/facts.test.ts`
Expected: FAIL, module unresolved.

- [ ] **Step 3: Write the facts builder**

`src/risk/facts.ts`:

```ts
import picomatch from "picomatch";
import type { RptConfig } from "../config/schema.js";
import type { VerifierResult } from "../domain/verdict.js";

export type SensitiveMatch = { category: string; paths: string[] };

export type RunFacts = {
	pathsChanged: string[];
	fileCount: number;
	linesAdded: number;
	linesRemoved: number;
	sensitiveMatches: SensitiveMatch[];
	dependencyChanged: boolean;
	testsAdded: number;
	testResult: "passed" | "failed" | "unknown";
	scanResult: "clean" | "findings" | "skipped";
	changeCoverage: number | null;
	undeclaredFiles: string[];
};

const TEST_FILE = /(^|\/)(test|tests|spec|__tests__)\//i;
const TEST_NAME = /\.(test|spec)\.[a-z]+$|_test\.[a-z]+$/i;

export function buildFacts(results: readonly VerifierResult[], config: RptConfig): RunFacts {
	const diff = factsOf(results, "diff-integrity");
	const pathsChanged = stringsOf(diff.observedPaths);
	return {
		pathsChanged,
		fileCount: pathsChanged.length,
		linesAdded: numberOf(diff.added),
		linesRemoved: numberOf(diff.removed),
		sensitiveMatches: matchSensitive(pathsChanged, config),
		dependencyChanged: diff.manifestChanged === true,
		testsAdded: pathsChanged.filter(isTestFile).length,
		testResult: testResultOf(results),
		scanResult: scanResultOf(results),
		changeCoverage: coverageOf(results),
		undeclaredFiles: stringsOf(diff.undeclared),
	};
}

function matchSensitive(paths: readonly string[], config: RptConfig): SensitiveMatch[] {
	return Object.entries(config.sensitivePaths)
		.map(([category, globs]) => ({ category, paths: paths.filter(picomatch(globs, { dot: true })) }))
		.filter((match) => match.paths.length > 0);
}

function testResultOf(results: readonly VerifierResult[]): RunFacts["testResult"] {
	const tests = results.find((result) => result.id === "tests");
	if (tests?.status === "passed") return "passed";
	if (tests?.status === "failed") return "failed";
	return "unknown";
}

function scanResultOf(results: readonly VerifierResult[]): RunFacts["scanResult"] {
	const security = results.find((result) => result.id === "security");
	if (security === undefined || security.status === "skipped") return "skipped";
	return security.status === "passed" ? "clean" : "findings";
}

function coverageOf(results: readonly VerifierResult[]): number | null {
	const value = factsOf(results, "test-quality").changeCoverage;
	return typeof value === "number" ? value : null;
}

function isTestFile(path: string): boolean {
	return TEST_FILE.test(path) || TEST_NAME.test(path);
}

function factsOf(results: readonly VerifierResult[], id: string): Record<string, unknown> {
	return results.find((result) => result.id === id)?.facts ?? {};
}

function stringsOf(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function numberOf(value: unknown): number {
	return typeof value === "number" ? value : 0;
}
```

Every unknown maps to the pessimistic value. A missing test verifier is `unknown`, never `passed`. A missing security verifier is `skipped`, never `clean`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run test/risk/facts.test.ts`
Expected: PASS, nine tests.

- [ ] **Step 5: Commit**

```bash
git add src/risk/facts.ts test/risk/facts.test.ts
git commit -m "feat: run facts assembled from verifier output with pessimistic defaults"
```

---

### Task 9: Risk engine

**Files:**
- Create: `src/risk/rules.ts`
- Create: `src/risk/assess.ts`
- Test: `test/risk/assess.test.ts`
- Modify: `test/domain/purity.test.ts`

**Interfaces:**
- Consumes: `RunFacts`, `RptConfig`
- Produces: `RiskRule`, `RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"`, `Contribution = { id: string; label: string; points: number }`, `RiskAssessment = { score: number; level: RiskLevel; contributions: Contribution[] }`; `DEFAULT_RULES: RiskRule[]`; `assessRisk(facts: RunFacts, config: RptConfig): RiskAssessment`

- [ ] **Step 1: Write the failing risk test**

`test/risk/assess.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/load.js";
import { assessRisk } from "../../src/risk/assess.js";
import type { RunFacts } from "../../src/risk/facts.js";

const clean: RunFacts = {
	pathsChanged: [],
	fileCount: 0,
	linesAdded: 0,
	linesRemoved: 0,
	sensitiveMatches: [],
	dependencyChanged: false,
	testsAdded: 0,
	testResult: "passed",
	scanResult: "clean",
	changeCoverage: 1,
	undeclaredFiles: [],
};

function facts(overrides: Partial<RunFacts>): RunFacts {
	return { ...clean, ...overrides };
}

describe("assessRisk", () => {
	it("is deterministic", () => {
		const input = facts({ fileCount: 3 });
		expect(assessRisk(input, DEFAULT_CONFIG)).toEqual(assessRisk(input, DEFAULT_CONFIG));
	});

	it("never scores below zero", () => {
		expect(assessRisk(clean, DEFAULT_CONFIG).score).toBe(0);
	});

	it("never scores above one hundred", () => {
		const worst = facts({
			fileCount: 500,
			sensitiveMatches: [
				{ category: "auth", paths: ["a"] },
				{ category: "database", paths: ["b"] },
				{ category: "infra", paths: ["c"] },
			],
			dependencyChanged: true,
			undeclaredFiles: ["x"],
			testResult: "failed",
			scanResult: "findings",
			changeCoverage: 0,
		});
		expect(assessRisk(worst, DEFAULT_CONFIG).score).toBe(100);
	});

	it("charges twenty five for an auth change", () => {
		const assessment = assessRisk(facts({ sensitiveMatches: [{ category: "auth", paths: ["src/auth/a.ts"] }] }), DEFAULT_CONFIG);
		expect(assessment.contributions.find((entry) => entry.id === "sensitive-auth")?.points).toBe(25);
	});

	it("caps the per-file charge at ten", () => {
		const assessment = assessRisk(facts({ fileCount: 40 }), DEFAULT_CONFIG);
		expect(assessment.contributions.find((entry) => entry.id === "files-changed-count")?.points).toBe(10);
	});

	it("credits added regression tests", () => {
		const assessment = assessRisk(facts({ testsAdded: 2 }), DEFAULT_CONFIG);
		expect(assessment.contributions.find((entry) => entry.id === "tests-added")?.points).toBe(-10);
	});

	it("bands the score", () => {
		expect(assessRisk(clean, DEFAULT_CONFIG).level).toBe("LOW");
		expect(assessRisk(facts({ sensitiveMatches: [{ category: "auth", paths: ["a"] }], testResult: "unknown", scanResult: "skipped" }), DEFAULT_CONFIG).level).toBe("HIGH");
	});

	it("explains every point it charged", () => {
		const assessment = assessRisk(facts({ fileCount: 7, dependencyChanged: true }), DEFAULT_CONFIG);
		const summed = assessment.contributions.reduce((total, entry) => total + entry.points, 0);
		expect(assessment.score).toBe(Math.min(100, Math.max(0, summed)));
	});

	it("honours a config override of a rule's points", () => {
		const config = { ...DEFAULT_CONFIG, ruleOverrides: { "dependency-changed": 5 } };
		const assessment = assessRisk(facts({ dependencyChanged: true }), config);
		expect(assessment.contributions.find((entry) => entry.id === "dependency-changed")?.points).toBe(5);
	});

	it("rejects an override naming a rule that does not exist", () => {
		const config = { ...DEFAULT_CONFIG, ruleOverrides: { "no-such-rule": 5 } };
		expect(() => assessRisk(clean, config)).toThrow(/no-such-rule/);
	});
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run test/risk/assess.test.ts`
Expected: FAIL, module unresolved.

- [ ] **Step 3: Write the rules**

`src/risk/rules.ts`:

```ts
import type { RunFacts } from "./facts.js";

export type RiskRule = {
	id: string;
	label: string;
	points: number | ((facts: RunFacts) => number);
	when: (facts: RunFacts) => boolean;
};

const MAX_FILE_POINTS = 10;

function hasCategory(facts: RunFacts, category: string): boolean {
	return facts.sensitiveMatches.some((match) => match.category === category);
}

export const DEFAULT_RULES: readonly RiskRule[] = [
	{ id: "sensitive-auth", label: "Authentication or authorization paths modified", points: 25, when: (facts) => hasCategory(facts, "auth") },
	{ id: "sensitive-database", label: "Database access or migration paths modified", points: 20, when: (facts) => hasCategory(facts, "database") },
	{ id: "sensitive-infra", label: "Infrastructure or deployment paths modified", points: 20, when: (facts) => hasCategory(facts, "infra") },
	{ id: "dependency-changed", label: "Production dependency changed", points: 20, when: (facts) => facts.dependencyChanged },
	{ id: "undeclared-files", label: "Undeclared files in diff", points: 15, when: (facts) => facts.undeclaredFiles.length > 0 },
	{ id: "files-changed-bulk", label: "More than ten files changed", points: 10, when: (facts) => facts.fileCount > 10 },
	{ id: "files-changed-count", label: "Files changed", points: (facts) => Math.min(facts.fileCount, MAX_FILE_POINTS), when: (facts) => facts.fileCount > 0 },
	{ id: "scan-findings", label: "Security scan produced findings", points: 25, when: (facts) => facts.scanResult === "findings" },
	{ id: "scan-skipped", label: "Security scan skipped", points: 10, when: (facts) => facts.scanResult === "skipped" },
	{ id: "tests-unknown-or-failing", label: "Test result unknown or failing", points: 15, when: (facts) => facts.testResult !== "passed" },
	{ id: "tests-added", label: "Regression tests added", points: -10, when: (facts) => facts.testsAdded > 0 },
	{ id: "tests-passed", label: "All tests passed", points: -5, when: (facts) => facts.testResult === "passed" },
	{ id: "scan-clean", label: "Security scan clean", points: -10, when: (facts) => facts.scanResult === "clean" },
	{ id: "coverage-high", label: "Change coverage above eighty percent", points: -5, when: (facts) => (facts.changeCoverage ?? 0) > 0.8 },
];
```

- [ ] **Step 4: Write the assessor**

`src/risk/assess.ts`:

```ts
import type { RptConfig } from "../config/schema.js";
import type { RunFacts } from "./facts.js";
import { DEFAULT_RULES, type RiskRule } from "./rules.js";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type Contribution = { id: string; label: string; points: number };

export type RiskAssessment = { score: number; level: RiskLevel; contributions: Contribution[] };

export function assessRisk(facts: RunFacts, config: RptConfig): RiskAssessment {
	assertOverridesKnown(config);
	const contributions = DEFAULT_RULES.filter((rule) => rule.when(facts)).map((rule) =>
		contributionOf(rule, facts, config),
	);
	const score = clamp(contributions.reduce((total, entry) => total + entry.points, 0));
	return { score, level: levelOf(score, config), contributions };
}

function contributionOf(rule: RiskRule, facts: RunFacts, config: RptConfig): Contribution {
	const override = config.ruleOverrides[rule.id];
	const points = override ?? (typeof rule.points === "function" ? rule.points(facts) : rule.points);
	return { id: rule.id, label: rule.label, points };
}

function assertOverridesKnown(config: RptConfig): void {
	const known = new Set(DEFAULT_RULES.map((rule) => rule.id));
	const unknown = Object.keys(config.ruleOverrides).filter((id) => !known.has(id));
	if (unknown.length > 0) throw new Error(`unknown risk rule override(s): ${unknown.join(", ")}`);
}

function levelOf(score: number, config: RptConfig): RiskLevel {
	if (score >= config.thresholds.block) return "CRITICAL";
	if (score >= config.thresholds.approval) return "HIGH";
	if (score >= config.thresholds.review) return "MEDIUM";
	return "LOW";
}

function clamp(score: number): number {
	return Math.min(100, Math.max(0, score));
}
```

- [ ] **Step 5: Extend the purity guard to cover the risk module**

In `test/domain/purity.test.ts`, run the same forbidden-import check over `src/risk` as well as `src/domain`. `picomatch` is a pure matcher and is allowed; `node:fs`, `node:child_process` and `node:net` are not.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm vitest run test/risk test/domain/purity.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/risk test/risk test/domain/purity.test.ts
git commit -m "feat: pure deterministic risk engine with itemised contributions"
```

---

### Task 10: Policy decision and human approval

**Files:**
- Create: `src/domain/policy.ts`
- Create: `src/app/approveRun.ts`
- Test: `test/domain/policy.test.ts`
- Test: `test/app/approveRun.test.ts`

**Interfaces:**
- Consumes: `RiskLevel`, `VerdictName`, `RunId`
- Produces: `Decision = "auto" | "review" | "approval" | "block"`; `decide(verdict: VerdictName, level: RiskLevel): Decision`; `Approval = { runId; decision: "approved" | "rejected"; by: string; at: string; override: boolean }`; `approveRun(repoRoot, runId, actor: Actor): Promise<Approval>`; `rejectRun(...)`; `Actor = { name: string; interactive: boolean; agentContext: boolean }`

- [ ] **Step 1: Write the failing policy test**

`test/domain/policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decide } from "../../src/domain/policy.js";

describe("decide", () => {
	it("clears a verified low risk run automatically", () => {
		expect(decide("VERIFIED", "LOW")).toBe("auto");
	});

	it("recommends review for a verified medium risk run without blocking", () => {
		expect(decide("VERIFIED", "MEDIUM")).toBe("review");
	});

	it("requires approval for a verified high risk run", () => {
		expect(decide("VERIFIED", "HIGH")).toBe("approval");
	});

	it("blocks a critical run outright, with no approval path", () => {
		expect(decide("VERIFIED", "CRITICAL")).toBe("block");
	});

	it("requires approval for a failed run even at low risk", () => {
		expect(decide("FAILED", "LOW")).toBe("approval");
	});

	it("requires approval for an unverified run even at low risk", () => {
		expect(decide("UNVERIFIED", "LOW")).toBe("approval");
	});

	it("still blocks a failed critical run rather than offering approval", () => {
		expect(decide("FAILED", "CRITICAL")).toBe("block");
	});
});
```

- [ ] **Step 2: Write the policy**

`src/domain/policy.ts`:

```ts
import type { RiskLevel } from "../risk/assess.js";
import type { VerdictName } from "./verdict.js";

export type Decision = "auto" | "review" | "approval" | "block";

export function decide(verdict: VerdictName, level: RiskLevel): Decision {
	if (level === "CRITICAL") return "block";
	if (verdict !== "VERIFIED") return "approval";
	if (level === "HIGH") return "approval";
	return level === "MEDIUM" ? "review" : "auto";
}
```

CRITICAL is checked first so no verdict can unlock it. A blocked run has no approval path by design; the change must be reduced, not signed off.

- [ ] **Step 3: Write the failing approval test**

`test/app/approveRun.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { approveRun, rejectRun, type Actor } from "../../src/app/approveRun.js";
import { initRepo } from "../../src/app/initRepo.js";
import { verifyRun } from "../../src/app/verifyRun.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

const human: Actor = { name: "klyne", interactive: true, agentContext: false };
const agent: Actor = { name: "claude", interactive: false, agentContext: true };

async function verifiedRepo(): Promise<string> {
	const repo = await makeFixtureRepo();
	await initRepo(repo);
	await driveFakeAgent(repo, [
		{ kind: "start", transcriptPath: null },
		{ kind: "edit", path: "a.ts", body: "1\n" },
		{ kind: "stop" },
	]);
	await verifyRun(repo, 1);
	return repo;
}

describe("approveRun", () => {
	it("records an approval by a human at a terminal", async () => {
		const approval = await approveRun(await verifiedRepo(), 1, human);
		expect(approval.decision).toBe("approved");
		expect(approval.by).toBe("klyne");
	});

	it("refuses an actor running inside an agent context", async () => {
		await expect(approveRun(await verifiedRepo(), 1, agent)).rejects.toThrow(/human/i);
	});

	it("refuses a non-interactive actor even outside an agent context", async () => {
		const piped: Actor = { name: "ci", interactive: false, agentContext: false };
		await expect(approveRun(await verifiedRepo(), 1, piped)).rejects.toThrow(/terminal/i);
	});

	it("marks approval of an unverified run as an override", async () => {
		const approval = await approveRun(await verifiedRepo(), 1, human);
		expect(approval.override).toBe(true);
	});

	it("refuses to approve a run twice", async () => {
		const repo = await verifiedRepo();
		await approveRun(repo, 1, human);
		await expect(approveRun(repo, 1, human)).rejects.toThrow(/already/i);
	});

	it("records a rejection", async () => {
		const rejection = await rejectRun(await verifiedRepo(), 1, human);
		expect(rejection.decision).toBe("rejected");
	});

	it("refuses to approve a run that does not exist", async () => {
		await expect(approveRun(await verifiedRepo(), 99, human)).rejects.toThrow();
	});
});
```

The override assertion holds because the fixture repo has no test command, so the run verifies as UNVERIFIED. That is the honest default for a repo with no tests.

- [ ] **Step 4: Write the approval use case**

`src/app/approveRun.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunId } from "../domain/events.js";
import { appendEvent } from "../store/eventLog.js";
import { rptDirOf, runDirOf } from "../store/paths.js";
import { upsertRun } from "../store/runIndex.js";
import { loadRun } from "./loadRun.js";
import { readVerdict } from "./verifyRun.js";

export type Actor = { name: string; interactive: boolean; agentContext: boolean };

export type Approval = {
	runId: RunId;
	decision: "approved" | "rejected";
	by: string;
	at: string;
	override: boolean;
};

export function actorFromEnvironment(): Actor {
	return {
		name: process.env.USER ?? process.env.LOGNAME ?? "unknown",
		interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
		agentContext: process.env.RPT_AGENT_CONTEXT === "1" || process.env.CLAUDECODE === "1",
	};
}

export function approveRun(repoRoot: string, runId: RunId, actor: Actor): Promise<Approval> {
	return record(repoRoot, runId, actor, "approved");
}

export function rejectRun(repoRoot: string, runId: RunId, actor: Actor): Promise<Approval> {
	return record(repoRoot, runId, actor, "rejected");
}

export async function readApproval(repoRoot: string, runId: RunId): Promise<Approval | null> {
	try {
		return JSON.parse(await readFile(approvalPath(repoRoot, runId), "utf8")) as Approval;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function record(
	repoRoot: string,
	runId: RunId,
	actor: Actor,
	decision: Approval["decision"],
): Promise<Approval> {
	assertHuman(actor);
	if ((await readApproval(repoRoot, runId)) !== null) {
		throw new Error(`run ${runId} already has a recorded decision`);
	}
	const run = await loadRun(repoRoot, runId);
	const verdict = await readVerdict(repoRoot, runId);
	if (verdict === null) throw new Error(`run ${runId} has not been verified yet`);
	const approval: Approval = {
		runId,
		decision,
		by: actor.name,
		at: new Date().toISOString(),
		override: verdict.name !== "VERIFIED",
	};
	await writeFile(approvalPath(repoRoot, runId), `${JSON.stringify(approval, null, 2)}\n`, "utf8");
	const rptDir = rptDirOf(repoRoot);
	await appendEvent(rptDir, runId, {
		ts: approval.at,
		source: "rpt",
		kind: decision === "approved" ? "ApprovalGranted" : "ApprovalDenied",
		payload: { by: approval.by, override: approval.override },
	});
	await upsertRun(rptDir, {
		id: runId,
		task: run.task,
		state: decision === "approved" ? "APPROVED" : "REJECTED",
		startedAt: run.startedAt,
		endedAt: run.endedAt,
	});
	return approval;
}

function assertHuman(actor: Actor): void {
	if (actor.agentContext) {
		throw new Error("approval must come from a human, and this process is running inside an agent context");
	}
	if (!actor.interactive) {
		throw new Error("approval requires an interactive terminal");
	}
}

function approvalPath(repoRoot: string, runId: RunId): string {
	return join(runDirOf(rptDirOf(repoRoot), runId), "approval.json");
}
```

`assertHuman` is the load-bearing function of the whole project. Two independent conditions must hold: the process is attached to a terminal, and it is not running inside a known agent context. Either alone is too weak.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run test/domain/policy.test.ts test/app/approveRun.test.ts`
Expected: PASS, fourteen tests.

- [ ] **Step 6: Commit**

```bash
git add src/domain/policy.ts src/app/approveRun.ts test/domain/policy.test.ts test/app/approveRun.test.ts
git commit -m "feat: policy decision and human-only approval with agent-context refusal"
```

---

### Task 11: Commit gate

**Files:**
- Create: `src/app/gateCommit.ts`
- Modify: `src/app/initRepo.ts`
- Create: `src/app/installGitHooks.ts`
- Test: `test/app/gateCommit.test.ts`
- Test: `test/app/installGitHooks.test.ts`

**Interfaces:**
- Consumes: `activeRun`, `verifyRun`, `readVerdict`, `readApproval`, `assessRisk`, `buildFacts`, `decide`
- Produces: `GateOutcome = { allowed: boolean; exitCode: number; message: string }`; `gateCommit(repoRoot: string): Promise<GateOutcome>`; `installGitHooks(repoRoot: string): Promise<void>`

- [ ] **Step 1: Write the failing gate test**

`test/app/gateCommit.test.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approveRun, type Actor } from "../../src/app/approveRun.js";
import { gateCommit } from "../../src/app/gateCommit.js";
import { initRepo } from "../../src/app/initRepo.js";
import { verifyRun } from "../../src/app/verifyRun.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

const human: Actor = { name: "klyne", interactive: true, agentContext: false };

async function repoWithRun(config: Record<string, unknown>, path = "a.ts"): Promise<string> {
	const repo = await makeFixtureRepo();
	await initRepo(repo);
	await writeFile(join(repo, "rpt.config.json"), JSON.stringify(config));
	await driveFakeAgent(repo, [
		{ kind: "start", transcriptPath: null },
		{ kind: "edit", path, body: "export const a = 1;\n" },
		{ kind: "stop" },
	]);
	return repo;
}

describe("gateCommit", () => {
	it("allows a commit when there is no active run", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		const outcome = await gateCommit(repo);
		expect(outcome.allowed).toBe(true);
		expect(outcome.exitCode).toBe(0);
	});

	it("verifies the run itself when it has not been verified", async () => {
		const repo = await repoWithRun({ testCommand: "exit 0" });
		await gateCommit(repo);
		const { readVerdict } = await import("../../src/app/verifyRun.js");
		expect(await readVerdict(repo, 1)).not.toBeNull();
	});

	it("blocks an unverified run and names the approval command", async () => {
		const repo = await repoWithRun({});
		const outcome = await gateCommit(repo);
		expect(outcome.allowed).toBe(false);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.message).toContain("rpt approve 1");
	});

	it("allows the commit once a human has approved", async () => {
		const repo = await repoWithRun({});
		await verifyRun(repo, 1);
		await approveRun(repo, 1, human);
		expect((await gateCommit(repo)).allowed).toBe(true);
	});

	it("keeps blocking after a rejection", async () => {
		const repo = await repoWithRun({});
		await verifyRun(repo, 1);
		const { rejectRun } = await import("../../src/app/approveRun.js");
		await rejectRun(repo, 1, human);
		expect((await gateCommit(repo)).allowed).toBe(false);
	});

	it("blocks a critical run even with an approval on file", async () => {
		const repo = await repoWithRun({ thresholds: { review: 1, approval: 2, block: 3 } }, "src/auth/keys.ts");
		await verifyRun(repo, 1);
		await approveRun(repo, 1, human);
		const outcome = await gateCommit(repo);
		expect(outcome.allowed).toBe(false);
		expect(outcome.message).toMatch(/critical/i);
	});

	it("records the bypass rather than staying silent", async () => {
		const repo = await repoWithRun({});
		process.env.RPT_BYPASS = "1";
		const outcome = await gateCommit(repo);
		delete process.env.RPT_BYPASS;
		expect(outcome.allowed).toBe(true);
		const { readEvents } = await import("../../src/store/eventLog.js");
		const { rptDirOf } = await import("../../src/store/paths.js");
		const { events } = await readEvents(rptDirOf(repo), 1);
		expect(events.some((event) => event.payload.bypass === true)).toBe(true);
	});
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run test/app/gateCommit.test.ts`
Expected: FAIL, module unresolved.

- [ ] **Step 3: Write the gate**

`src/app/gateCommit.ts`:

```ts
import { loadConfig } from "../config/load.js";
import { decide } from "../domain/policy.js";
import type { Verdict } from "../domain/verdict.js";
import { assessRisk, type RiskAssessment } from "../risk/assess.js";
import { buildFacts } from "../risk/facts.js";
import { appendEvent } from "../store/eventLog.js";
import { rptDirOf } from "../store/paths.js";
import { activeRun, type RunIndexEntry } from "../store/runIndex.js";
import { readApproval } from "./approveRun.js";
import { readVerdict, verifyRun } from "./verifyRun.js";

export type GateOutcome = { allowed: boolean; exitCode: number; message: string };

const ALLOWED: GateOutcome = { allowed: true, exitCode: 0, message: "" };

export async function gateCommit(repoRoot: string): Promise<GateOutcome> {
	const entry = await activeRun(rptDirOf(repoRoot));
	if (entry === null) return ALLOWED;
	const verdict = (await readVerdict(repoRoot, entry.id)) ?? (await verifyRun(repoRoot, entry.id));
	const risk = assessRisk(buildFacts(verdict.results, await loadConfig(repoRoot)), await loadConfig(repoRoot));
	const outcome = await judge(repoRoot, entry, verdict, risk);
	await recordGateEvent(repoRoot, entry, risk, outcome);
	return outcome;
}

async function judge(
	repoRoot: string,
	entry: RunIndexEntry,
	verdict: Verdict,
	risk: RiskAssessment,
): Promise<GateOutcome> {
	const decision = decide(verdict.name, risk.level);
	if (decision === "auto" || decision === "review") return ALLOWED;
	if (decision === "block") return blocked(entry, verdict, risk, "risk level CRITICAL cannot be approved");
	if (bypassRequested()) return ALLOWED;
	const approval = await readApproval(repoRoot, entry.id);
	if (approval?.decision === "approved") return ALLOWED;
	if (approval?.decision === "rejected") return blocked(entry, verdict, risk, "this run was rejected");
	return blocked(entry, verdict, risk, `approve with:  rpt approve ${entry.id}`);
}

function blocked(
	entry: RunIndexEntry,
	verdict: Verdict,
	risk: RiskAssessment,
	remedy: string,
): GateOutcome {
	return {
		allowed: false,
		exitCode: 1,
		message: [
			"rpt: commit blocked",
			"",
			`  run ${entry.id}  ${entry.task}`,
			`  risk ${risk.score} ${risk.level}`,
			`  verdict ${verdict.name}`,
			"",
			`  ${remedy}`,
			"",
		].join("\n"),
	};
}

function bypassRequested(): boolean {
	return process.env.RPT_BYPASS === "1";
}

async function recordGateEvent(
	repoRoot: string,
	entry: RunIndexEntry,
	risk: RiskAssessment,
	outcome: GateOutcome,
): Promise<void> {
	await appendEvent(rptDirOf(repoRoot), entry.id, {
		ts: new Date().toISOString(),
		source: "rpt",
		kind: outcome.allowed ? "ApprovalRequested" : "ApprovalDenied",
		payload: {
			score: risk.score,
			level: risk.level,
			allowed: outcome.allowed,
			bypass: outcome.allowed && bypassRequested(),
		},
	});
}
```

A bypass still produces an event carrying `bypass: true` and the score at the time. The commit proceeds; the record does not pretend it was clean.

- [ ] **Step 4: Write the git hook installer**

`src/app/installGitHooks.ts`:

```ts
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MARKER = "# rpt gate";

const PRE_COMMIT = `#!/bin/sh
${MARKER}
rpt gate || exit 1
`;

const POST_COMMIT = `#!/bin/sh
${MARKER}
rpt record --quiet || true
`;

export async function installGitHooks(repoRoot: string): Promise<void> {
	const dir = join(repoRoot, ".git", "hooks");
	await mkdir(dir, { recursive: true });
	await install(join(dir, "pre-commit"), PRE_COMMIT);
	await install(join(dir, "post-commit"), POST_COMMIT);
}

async function install(path: string, body: string): Promise<void> {
	const existing = await readOrNull(path);
	if (existing !== null && existing.includes(MARKER)) return;
	const merged = existing === null ? body : `${existing.trimEnd()}\n${body.split("\n").slice(1).join("\n")}`;
	await writeFile(path, merged, "utf8");
	await chmod(path, 0o755);
}

async function readOrNull(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
```

`test/app/installGitHooks.test.ts` asserts: a fresh repo gets an executable pre-commit hook containing `rpt gate`; an existing hook is appended to rather than replaced; a second install is a no-op; and the post-commit hook never fails the commit.

- [ ] **Step 5: Extend initRepo**

Call `installGitHooks(repoRoot)` from `initRepo` and add `gitHooksInstalled: boolean` to `InitReport`. Update the Plan 1 init test's expectations accordingly.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm vitest run test/app`
Expected: PASS, including the updated init test.

- [ ] **Step 7: Commit**

```bash
git add src/app/gateCommit.ts src/app/installGitHooks.ts src/app/initRepo.ts test/app
git commit -m "feat: pre-commit gate with recorded bypass and chained git hooks"
```

---

### Task 12: Attestation

**Files:**
- Create: `src/app/recordCommit.ts`
- Test: `test/app/recordCommit.test.ts`

**Interfaces:**
- Consumes: `git`, `readVerdict`, `readApproval`, `assessRisk`, `costOf`, `loadPricing`, `readEvents`
- Produces: `attestationFor(...): string`; `recordCommit(repoRoot: string): Promise<string | null>`

- [ ] **Step 1: Write the failing attestation test**

`test/app/recordCommit.test.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approveRun, type Actor } from "../../src/app/approveRun.js";
import { initRepo } from "../../src/app/initRepo.js";
import { recordCommit } from "../../src/app/recordCommit.js";
import { verifyRun } from "../../src/app/verifyRun.js";
import { git } from "../../src/git/exec.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

const human: Actor = { name: "klyne", interactive: true, agentContext: false };

async function committedRun(): Promise<string> {
	const repo = await makeFixtureRepo();
	await initRepo(repo);
	await driveFakeAgent(repo, [
		{ kind: "start", transcriptPath: null },
		{ kind: "edit", path: "a.ts", body: "export const a = 1;\n" },
		{ kind: "stop" },
	]);
	await verifyRun(repo, 1);
	await approveRun(repo, 1, human);
	await writeFile(join(repo, "a.ts"), "export const a = 1;\n");
	await git(repo, ["add", "-A"]);
	await git(repo, ["commit", "-q", "-m", "change", "--no-verify"]);
	return repo;
}

describe("recordCommit", () => {
	it("attaches a note to the new commit", async () => {
		const repo = await committedRun();
		await recordCommit(repo);
		const note = await git(repo, ["notes", "--ref=rpt", "show", "HEAD"]);
		expect(note).toContain("run 1");
	});

	it("states the verdict and the risk level", async () => {
		const repo = await committedRun();
		await recordCommit(repo);
		const note = await git(repo, ["notes", "--ref=rpt", "show", "HEAD"]);
		expect(note).toMatch(/verdict (VERIFIED|FAILED|UNVERIFIED)/);
		expect(note).toMatch(/risk \d+ (LOW|MEDIUM|HIGH|CRITICAL)/);
	});

	it("distinguishes an override from a clean approval", async () => {
		const repo = await committedRun();
		await recordCommit(repo);
		const note = await git(repo, ["notes", "--ref=rpt", "show", "HEAD"]);
		expect(note).toMatch(/approved despite UNVERIFIED by klyne/);
	});

	it("includes a digest of the event log", async () => {
		const repo = await committedRun();
		await recordCommit(repo);
		const note = await git(repo, ["notes", "--ref=rpt", "show", "HEAD"]);
		expect(note).toMatch(/digest sha256:[0-9a-f]{16}/);
	});

	it("does nothing and returns null when there is no adjudicated run", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		expect(await recordCommit(repo)).toBeNull();
	});

	it("says the cost is unknown rather than inventing one", async () => {
		const repo = await committedRun();
		await recordCommit(repo);
		const note = await git(repo, ["notes", "--ref=rpt", "show", "HEAD"]);
		expect(note).toContain("cost unknown");
	});
});
```

- [ ] **Step 2: Write recordCommit**

`src/app/recordCommit.ts`:

```ts
import { createHash } from "node:crypto";
import { loadConfig } from "../config/load.js";
import type { Verdict } from "../domain/verdict.js";
import { git } from "../git/exec.js";
import { costOf } from "../pricing/cost.js";
import { loadPricing } from "../pricing/table.js";
import { assessRisk } from "../risk/assess.js";
import { buildFacts } from "../risk/facts.js";
import { readEvents } from "../store/eventLog.js";
import { rptDirOf } from "../store/paths.js";
import { activeRun, upsertRun } from "../store/runIndex.js";
import { readApproval, type Approval } from "./approveRun.js";
import { loadRun } from "./loadRun.js";
import { readVerdict } from "./verifyRun.js";

export async function recordCommit(repoRoot: string): Promise<string | null> {
	const entry = await activeRun(rptDirOf(repoRoot));
	if (entry === null) return null;
	const verdict = await readVerdict(repoRoot, entry.id);
	if (verdict === null) return null;
	const note = await attestationFor(repoRoot, verdict);
	await git(repoRoot, ["notes", "--ref=rpt", "add", "-f", "-m", note, "HEAD"]);
	const run = await loadRun(repoRoot, entry.id);
	await upsertRun(rptDirOf(repoRoot), {
		id: entry.id,
		task: run.task,
		state: "RECORDED",
		startedAt: run.startedAt,
		endedAt: run.endedAt,
	});
	return note;
}

export async function attestationFor(repoRoot: string, verdict: Verdict): Promise<string> {
	const run = await loadRun(repoRoot, verdict.runId);
	const config = await loadConfig(repoRoot);
	const risk = assessRisk(buildFacts(verdict.results, config), config);
	const cost = costOf(run.usage, await loadPricing(rptDirOf(repoRoot)));
	const tests = verdict.results.find((result) => result.id === "tests")?.facts ?? {};
	return [
		`run ${run.id} | ${run.task}`,
		`verdict ${verdict.name} | risk ${risk.score} ${risk.level}`,
		`tests ${tests.passed ?? "unknown"} passed ${tests.failed ?? "unknown"} failed | files ${risk.contributions.length > 0 ? run.claims.mutatedPaths.length : 0} | ${costLine(cost.usd)}`,
		approvalLine(await readApproval(repoRoot, verdict.runId), verdict),
		`digest ${await digestOf(repoRoot, verdict.runId)}`,
		"",
	].join("\n");
}

function costLine(usd: number | null): string {
	return usd === null ? "cost unknown" : `cost ${usd.toFixed(2)} USD`;
}

function approvalLine(approval: Approval | null, verdict: Verdict): string {
	if (approval === null) return "cleared automatically";
	const verb = approval.override ? `approved despite ${verdict.name}` : "approved";
	return `${approval.decision === "rejected" ? "rejected" : verb} by ${approval.by} at ${approval.at}`;
}

async function digestOf(repoRoot: string, runId: number): Promise<string> {
	const { events } = await readEvents(rptDirOf(repoRoot), runId);
	const hash = createHash("sha256").update(JSON.stringify(events)).digest("hex");
	return `sha256:${hash.slice(0, 16)}`;
}
```

- [ ] **Step 3: Run the test and confirm it passes**

Run: `pnpm vitest run test/app/recordCommit.test.ts`
Expected: PASS, six tests.

- [ ] **Step 4: Commit**

```bash
git add src/app/recordCommit.ts test/app/recordCommit.test.ts
git commit -m "feat: git note attestation distinguishing approval from override"
```

---

### Task 13: Adjudication CLI commands

**Files:**
- Modify: `src/cli/index.ts`
- Create: `src/cli/renderRisk.ts`
- Test: `test/cli/renderRisk.test.ts`

**Interfaces:**
- Consumes: `RiskAssessment`, `Verdict`, `OutputFormat`
- Produces: `renderRisk(assessment: RiskAssessment, format: OutputFormat): string`; `renderVerdict(verdict: Verdict, format: OutputFormat): string`

- [ ] **Step 1: Write the failing render test**

`test/cli/renderRisk.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderRisk, renderVerdict } from "../../src/cli/renderRisk.js";
import type { RiskAssessment } from "../../src/risk/assess.js";
import type { Verdict } from "../../src/domain/verdict.js";

const assessment: RiskAssessment = {
	score: 47,
	level: "MEDIUM",
	contributions: [
		{ id: "sensitive-auth", label: "Authentication or authorization paths modified", points: 25 },
		{ id: "tests-added", label: "Regression tests added", points: -10 },
	],
};

const verdict: Verdict = {
	runId: 1,
	name: "UNVERIFIED",
	results: [{ id: "tests", status: "skipped", reason: "no test command", facts: {} }],
	decidedAt: "2026-09-09T10:00:00.000Z",
};

describe("renderRisk", () => {
	it("shows the score and level", () => {
		expect(renderRisk(assessment, "text")).toContain("47");
		expect(renderRisk(assessment, "text")).toContain("MEDIUM");
	});

	it("lists every contribution with its sign", () => {
		const output = renderRisk(assessment, "text");
		expect(output).toContain("+25");
		expect(output).toContain("-10");
	});

	it("emits parseable json", () => {
		expect(JSON.parse(renderRisk(assessment, "json")).score).toBe(47);
	});

	it("keeps the agent format under a token budget", () => {
		expect(renderRisk(assessment, "agent").length).toBeLessThan(400);
	});
});

describe("renderVerdict", () => {
	it("states the reason a verifier was skipped", () => {
		expect(renderVerdict(verdict, "text")).toContain("no test command");
	});

	it("never prints a skipped verifier as a pass", () => {
		expect(renderVerdict(verdict, "text")).not.toMatch(/tests\s+passed/i);
	});
});
```

- [ ] **Step 2: Write the renderers**

`src/cli/renderRisk.ts`. Text form prints a score line, a bar built from block characters, then one line per contribution with the label left-aligned and signed points right-aligned. JSON form is `JSON.stringify(value, null, 2)`. Agent form is two lines for risk and one line per non-passing verifier.

```ts
import type { Verdict } from "../domain/verdict.js";
import type { RiskAssessment } from "../risk/assess.js";
import type { OutputFormat } from "./format.js";

const BAR_WIDTH = 20;

export function renderRisk(assessment: RiskAssessment, format: OutputFormat): string {
	if (format === "json") return JSON.stringify(assessment, null, 2);
	if (format === "agent") {
		return [
			`risk ${assessment.score} ${assessment.level}`,
			...assessment.contributions.map((entry) => `${signed(entry.points)} ${entry.id}`),
		].join("\n");
	}
	return [
		`RISK SCORE: ${assessment.score} / 100`,
		"",
		`  ${bar(assessment.score)}`,
		"",
		...assessment.contributions.map((entry) => `  ${entry.label.padEnd(48)}${signed(entry.points).padStart(5)}`),
		"",
		`  LEVEL: ${assessment.level}`,
		"",
	].join("\n");
}

export function renderVerdict(verdict: Verdict, format: OutputFormat): string {
	if (format === "json") return JSON.stringify(verdict, null, 2);
	const lines = verdict.results.map(
		(result) => `  ${result.id.padEnd(20)}${result.status}${result.reason === null ? "" : `  ${result.reason}`}`,
	);
	return [`VERDICT: ${verdict.name}`, "", ...lines, ""].join("\n");
}

function bar(score: number): string {
	const filled = Math.round((score / 100) * BAR_WIDTH);
	return `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
}

function signed(points: number): string {
	return points >= 0 ? `+${points}` : String(points);
}
```

- [ ] **Step 3: Add the commands**

Extend `src/cli/index.ts` with:

- `rpt verify <id>` calling `verifyRun`, printing `renderVerdict`.
- `rpt risk <id>` reading the verdict, building facts, printing `renderRisk`. Errors with a clear message when the run has not been verified.
- `rpt diff <id>` printing `diffPatch(repoRoot, run.baseSha, run.endSha)`.
- `rpt approve <id>` and `rpt reject <id>` calling `approveRun` and `rejectRun` with `actorFromEnvironment()`. On refusal, print the thrown message and exit 1.
- `rpt gate` calling `gateCommit`, writing `outcome.message` to stderr and setting `process.exitCode = outcome.exitCode`.
- `rpt record` calling `recordCommit`, always exiting 0.

- [ ] **Step 4: Verify the approval refusal by hand**

```bash
pnpm build
echo "" | RPT_AGENT_CONTEXT=1 node dist/cli/index.js approve 1
```

Expected: exit code 1 and a message saying approval must come from a human.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm test`
Expected: PASS, every suite.

- [ ] **Step 6: Commit**

```bash
git add src/cli test/cli
git commit -m "feat: verify, risk, diff, approve, reject, gate and record commands"
```

---

### Task 14: End-to-end gate

**Files:**
- Create: `test/e2e/gatedRun.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything

- [ ] **Step 1: Write the end-to-end gate test**

`test/e2e/gatedRun.test.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approveRun, type Actor } from "../../src/app/approveRun.js";
import { initRepo } from "../../src/app/initRepo.js";
import { recordCommit } from "../../src/app/recordCommit.js";
import { gateCommit } from "../../src/app/gateCommit.js";
import { verifyRun } from "../../src/app/verifyRun.js";
import { git } from "../../src/git/exec.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

const human: Actor = { name: "klyne", interactive: true, agentContext: false };

async function riskyRun(): Promise<string> {
	const repo = await makeFixtureRepo();
	await initRepo(repo);
	await writeFile(join(repo, "rpt.config.json"), JSON.stringify({ testCommand: "exit 0" }));
	await driveFakeAgent(repo, [
		{ kind: "start", transcriptPath: null },
		{ kind: "edit", path: "src-auth-pool.ts", body: "export const timeout = 5000;\n" },
		{ kind: "stop" },
	]);
	return repo;
}

describe("gated run, end to end", () => {
	it("blocks, then allows after approval, then records an attestation", async () => {
		const repo = await riskyRun();
		const blockedOutcome = await gateCommit(repo);
		expect(blockedOutcome.allowed).toBe(false);

		await approveRun(repo, 1, human);
		expect((await gateCommit(repo)).allowed).toBe(true);

		await git(repo, ["add", "-A"]);
		await git(repo, ["commit", "-q", "-m", "change", "--no-verify"]);
		await recordCommit(repo);
		expect(await git(repo, ["notes", "--ref=rpt", "show", "HEAD"])).toContain("run 1");
	});

	it("never lets an agent context clear its own run", async () => {
		const repo = await riskyRun();
		await verifyRun(repo, 1);
		const agent: Actor = { name: "claude", interactive: true, agentContext: true };
		await expect(approveRun(repo, 1, agent)).rejects.toThrow(/human/i);
		expect((await gateCommit(repo)).allowed).toBe(false);
	});

	it("leaves the user's index and working tree untouched throughout", async () => {
		const repo = await riskyRun();
		await gateCommit(repo);
		expect(await git(repo, ["diff", "--cached", "--name-only"])).toBe("");
		expect(await git(repo, ["worktree", "list"])).not.toContain("rpt-wt-");
	});
});
```

- [ ] **Step 2: Run the test and confirm it passes**

Run: `pnpm vitest run test/e2e`
Expected: PASS, both Plan 1 and Plan 2 end-to-end suites.

- [ ] **Step 3: Check coverage**

Run: `pnpm test:cov`
Expected: all thresholds at or above 80.

- [ ] **Step 4: Update the README**

Document `rpt verify`, `rpt risk`, `rpt diff`, `rpt approve`, `rpt reject`, the gate, the bypass and its visibility, the attestation format, and the rule that approval requires a human at a terminal.

- [ ] **Step 5: Review the whole plan's output**

Dispatch the `swe:swe` agent over the full Plan 2 diff. Fix every violation before closing.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/gatedRun.test.ts README.md
git commit -m "test: end-to-end gate blocking, approval and attestation"
```

---

## Plan 2 self-review

**Spec coverage.** Section 10 verifiers are Tasks 3 to 6, with the contract in Task 2 and orchestration in Task 7. Section 11 risk engine is Tasks 8 and 9, including the rule id table and the override validation. Section 12 policy, gate, approval and bypass are Tasks 10 and 11. Section 13 attestation is Task 12. Section 17's adjudication commands are Task 13. Section 19's rule that a verifier throwing becomes `skipped` is Task 2. Section 20's fixture-repo and gate-exit-code tests are distributed across Tasks 1, 4, 11 and 14.

**Deliberate deviation from the spec, flagged.** Spec section 8 says verification runs against the end snapshot in a worktree, and Task 1 implements that. The diff and security verifiers, however, read the diff through `repoRoot` rather than the worktree, because git diff between two shas needs the object database, not a checkout. The worktree is used for executing tests and coverage. This is correct but worth noting because it reads as an inconsistency at a glance.

**Type consistency.** `VerifierResult` is defined once and moved into `src/domain/verdict.ts` in Task 7 Step 2, with `src/verifiers/Verifier.ts` re-exporting it, so `src/risk/facts.ts` in Task 8 can import it without breaking the purity guard. `RunFacts` field names match between Task 8 and the rules in Task 9. `RiskLevel` is defined in `src/risk/assess.ts` and imported by `src/domain/policy.ts`, which is the one place `domain` depends on `risk`; both are pure, so the purity guard permits it. `Actor` is defined once in Task 10 and used unchanged in Tasks 11, 13 and 14.

**Known ordering constraint.** Task 7 must move `VerifierResult` into `src/domain/` before Task 8 imports it. If Tasks 8 and 9 are executed before Task 7, the purity guard test fails, which is the intended signal.
