# rpt Recorder Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every Claude Code agent run in this repo as a replayable, tamper-evident event log with git-anchored run boundaries and per-run token cost.

**Architecture:** Event-sourced. A Claude Code hook posts each agent action to a local unix-socket daemon, which appends a checksummed line to a per-run JSONL log. Run state is a pure fold over that log, never a mutated record. Run boundaries are captured as git snapshot commits built through a temporary index, so uncommitted agent work is still fully observed without touching the user's working tree or staging area.

**Tech Stack:** TypeScript ESM on Node 22+, pnpm, vitest, zod, commander, picomatch, proper-lockfile. No git library: the git binary is invoked directly from `src/git/`.

**Spec:** `docs/superpowers/specs/2026-09-09-rpt-design.md`

## Global Constraints

- Node >= 22. TypeScript strict mode, ESM only, `"type": "module"`.
- Package name `@klyne/rpt`, binary name `rpt`. The unscoped npm name `rpt` is taken.
- Code style: tabs, semicolons, double quotes.
- `src/domain/` and `src/risk/` import nothing from other `src/` directories and perform no I/O. Enforced by a test.
- Only `src/store/` writes under `.rpt/`. Only `src/git/` invokes the git binary.
- Every catch either records an event or rethrows. No silent failure anywhere.
- Collection is best effort and must never block or fail the agent. Hook processes always exit 0.
- Test coverage floor 80 percent, enforced in CI config from Task 1.
- All implementation is written by the `swe:clean-code` agent and reviewed by the `swe:swe` agent before a task is considered done.

---

### Task 1: Project scaffold and config loader

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/config/schema.ts`
- Create: `src/config/load.ts`
- Test: `test/config/load.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `RptConfig` type; `loadConfig(repoRoot: string): Promise<RptConfig>`; `DEFAULT_CONFIG: RptConfig`

- [ ] **Step 1: Create the package manifest**

```json
{
	"name": "@klyne/rpt",
	"version": "0.1.0",
	"type": "module",
	"bin": { "rpt": "./dist/cli/index.js" },
	"engines": { "node": ">=22" },
	"scripts": {
		"build": "tsc -p tsconfig.json",
		"test": "vitest run",
		"test:cov": "vitest run --coverage",
		"typecheck": "tsc --noEmit"
	},
	"dependencies": {
		"commander": "^12.1.0",
		"picomatch": "^4.0.2",
		"proper-lockfile": "^4.1.2",
		"zod": "^3.23.8"
	},
	"devDependencies": {
		"@types/node": "^22.7.5",
		"@types/picomatch": "^3.0.1",
		"@types/proper-lockfile": "^4.1.4",
		"@vitest/coverage-v8": "^2.1.2",
		"typescript": "^5.6.3",
		"vitest": "^2.1.2"
	}
}
```

Run `pnpm install`. If any listed version no longer resolves, install the current major with `pnpm add` and record the resolved version in the manifest. Never leave a version unpinned.

- [ ] **Step 2: Create tsconfig, vitest config and gitignore**

`tsconfig.json`:

```json
{
	"compilerOptions": {
		"target": "ES2023",
		"module": "NodeNext",
		"moduleResolution": "NodeNext",
		"strict": true,
		"noUncheckedIndexedAccess": true,
		"exactOptionalPropertyTypes": true,
		"outDir": "dist",
		"rootDir": "src",
		"declaration": true,
		"skipLibCheck": true
	},
	"include": ["src"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		coverage: {
			provider: "v8",
			thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
			exclude: ["dist/**", "test/**", "*.config.ts"],
		},
	},
});
```

`.gitignore`:

```
node_modules/
dist/
.rpt/
coverage/
```

- [ ] **Step 3: Write the failing config test**

`test/config/load.test.ts`:

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";

async function repoWith(config?: unknown): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "rpt-config-"));
	if (config !== undefined) {
		await writeFile(join(dir, "rpt.config.json"), JSON.stringify(config));
	}
	return dir;
}

describe("loadConfig", () => {
	it("returns defaults when no config file exists", async () => {
		const config = await loadConfig(await repoWith());
		expect(config.thresholds).toEqual({ review: 21, approval: 51, block: 81 });
		expect(config.testCommand).toBeNull();
	});

	it("merges user values over defaults", async () => {
		const config = await loadConfig(await repoWith({ testCommand: "pnpm test" }));
		expect(config.testCommand).toBe("pnpm test");
		expect(config.thresholds.approval).toBe(51);
	});

	it("rejects unknown keys instead of ignoring them", async () => {
		await expect(loadConfig(await repoWith({ tsetCommand: "pnpm test" }))).rejects.toThrow(
			/unknown key/i,
		);
	});

	it("rejects thresholds that are out of order", async () => {
		const bad = { thresholds: { review: 60, approval: 51, block: 81 } };
		await expect(loadConfig(await repoWith(bad))).rejects.toThrow(/ascending/i);
	});
});
```

- [ ] **Step 4: Run the test and confirm it fails**

Run: `pnpm vitest run test/config/load.test.ts`
Expected: FAIL, cannot resolve `../../src/config/load.js`.

- [ ] **Step 5: Write the schema**

`src/config/schema.ts`:

```ts
import { z } from "zod";

export const thresholdsSchema = z
	.object({ review: z.number().int(), approval: z.number().int(), block: z.number().int() })
	.refine(
		(t) => t.review < t.approval && t.approval < t.block,
		{ message: "thresholds must be ascending: review < approval < block" },
	);

export const configSchema = z
	.object({
		testCommand: z.string().nullable().default(null),
		coverageCommand: z.string().nullable().default(null),
		sensitivePaths: z.record(z.string(), z.array(z.string())).default({
			auth: ["**/auth/**", "**/*auth*.*", "**/session/**"],
			database: ["**/db/**", "**/migrations/**", "**/*repository*.*"],
			infra: ["infra/**", "Dockerfile*", ".github/workflows/**", "**/*.tf"],
		}),
		thresholds: thresholdsSchema.default({ review: 21, approval: 51, block: 81 }),
		ruleOverrides: z.record(z.string(), z.number()).default({}),
		verifiers: z
			.object({ testQuality: z.enum(["require", "warn", "off"]).default("warn") })
			.strict()
			.default({ testQuality: "warn" }),
	})
	.strict();

export type RptConfig = z.infer<typeof configSchema>;
```

- [ ] **Step 6: Write the loader**

`src/config/load.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { configSchema, type RptConfig } from "./schema.js";

export const DEFAULT_CONFIG: RptConfig = configSchema.parse({});

export async function loadConfig(repoRoot: string): Promise<RptConfig> {
	const raw = await readRawConfig(join(repoRoot, "rpt.config.json"));
	if (raw === null) return DEFAULT_CONFIG;
	const parsed = configSchema.safeParse(raw);
	if (!parsed.success) throw new Error(describeConfigFailure(parsed.error));
	return parsed.data;
}

async function readRawConfig(path: string): Promise<unknown | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch (error) {
		if (isMissingFile(error)) return null;
		throw new Error(`rpt.config.json is unreadable: ${(error as Error).message}`);
	}
}

function isMissingFile(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function describeConfigFailure(error: z.ZodError): string {
	const issues = error.issues.map((issue) => {
		const path = issue.path.join(".") || "root";
		if (issue.code === "unrecognized_keys") {
			return `unknown key ${issue.keys.join(", ")} at ${path}`;
		}
		return `${path}: ${issue.message}`;
	});
	return `rpt.config.json is invalid\n  ${issues.join("\n  ")}`;
}
```

Add `import type { z } from "zod";` at the top so `z.ZodError` resolves.

- [ ] **Step 7: Run the test and confirm it passes**

Run: `pnpm vitest run test/config/load.test.ts`
Expected: PASS, four tests.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore src/config test/config
git commit -m "feat: project scaffold and validated config loader"
```

---

### Task 2: Event types, canonical serialization and checksums

**Files:**
- Create: `src/domain/events.ts`
- Create: `src/domain/checksum.ts`
- Test: `test/domain/checksum.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `RunId`, `EventKind`, `EventSource`, `DraftEvent`, `AgentEvent`, `StoredEvent`; `canonicalize(event: AgentEvent): string`; `checksumOf(event: AgentEvent): string`; `verifyChecksum(stored: StoredEvent): boolean`

- [ ] **Step 1: Write the failing checksum test**

`test/domain/checksum.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canonicalize, checksumOf, verifyChecksum } from "../../src/domain/checksum.js";
import type { AgentEvent } from "../../src/domain/events.js";

const event: AgentEvent = {
	runId: 1,
	seq: 0,
	ts: "2026-09-09T10:00:00.000Z",
	source: "claude-code",
	kind: "FileMutated",
	payload: { path: "src/auth/pool.ts", operation: "modify" },
};

describe("canonicalize", () => {
	it("orders keys so equal events serialize identically", () => {
		const reordered = { ...event, payload: { operation: "modify", path: "src/auth/pool.ts" } };
		expect(canonicalize(reordered)).toBe(canonicalize(event));
	});

	it("orders nested payload keys too", () => {
		const a = { ...event, payload: { outer: { b: 2, a: 1 } } };
		const b = { ...event, payload: { outer: { a: 1, b: 2 } } };
		expect(canonicalize(a)).toBe(canonicalize(b));
	});
});

describe("checksumOf", () => {
	it("is stable for equal events", () => {
		expect(checksumOf(event)).toBe(checksumOf({ ...event }));
	});

	it("changes when any field changes", () => {
		expect(checksumOf({ ...event, seq: 1 })).not.toBe(checksumOf(event));
	});

	it("verifies a well formed stored event", () => {
		expect(verifyChecksum({ ...event, checksum: checksumOf(event) })).toBe(true);
	});

	it("rejects a stored event whose payload was edited after the fact", () => {
		const tampered = { ...event, checksum: checksumOf(event), payload: { path: "other.ts" } };
		expect(verifyChecksum(tampered)).toBe(false);
	});
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run test/domain/checksum.test.ts`
Expected: FAIL, cannot resolve `../../src/domain/checksum.js`.

- [ ] **Step 3: Write the event types**

`src/domain/events.ts`:

```ts
export type RunId = number;

export type EventKind =
	| "RunStarted"
	| "AgentStopped"
	| "RunCommitted"
	| "PromptSubmitted"
	| "ToolCallStarted"
	| "ToolCallCompleted"
	| "FileMutated"
	| "CommandStarted"
	| "CommandCompleted"
	| "ModelUsageRecorded"
	| "VerificationStarted"
	| "VerifierCompleted"
	| "RiskAssessed"
	| "ApprovalRequested"
	| "ApprovalGranted"
	| "ApprovalDenied"
	| "GapRecorded";

export type EventSource = "claude-code" | "rpt";

export type DraftEvent = {
	ts: string;
	source: EventSource;
	kind: EventKind;
	payload: Record<string, unknown>;
};

export type AgentEvent = DraftEvent & { runId: RunId; seq: number };

export type StoredEvent = AgentEvent & { checksum: string };
```

- [ ] **Step 4: Write canonicalization and checksums**

`src/domain/checksum.ts`:

```ts
import { createHash } from "node:crypto";
import type { AgentEvent, StoredEvent } from "./events.js";

export function canonicalize(event: AgentEvent): string {
	return JSON.stringify(sortValue(event));
}

export function checksumOf(event: AgentEvent): string {
	return createHash("sha256").update(canonicalize(event)).digest("hex");
}

export function verifyChecksum(stored: StoredEvent): boolean {
	const { checksum, ...event } = stored;
	return checksumOf(event) === checksum;
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value === null || typeof value !== "object") return value;
	const entries = Object.entries(value as Record<string, unknown>).sort(byKey);
	return Object.fromEntries(entries.map(([key, nested]) => [key, sortValue(nested)]));
}

function byKey(left: [string, unknown], right: [string, unknown]): number {
	return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run test/domain/checksum.test.ts`
Expected: PASS, six tests.

- [ ] **Step 6: Commit**

```bash
git add src/domain test/domain
git commit -m "feat: event types with canonical serialization and checksums"
```

---

### Task 3: Run state machine

**Files:**
- Create: `src/domain/state.ts`
- Test: `test/domain/state.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `RunState`; `transition(from: RunState, to: RunState): RunState`; `IllegalTransitionError`; `isTerminal(state: RunState): boolean`; `requiresHumanDecision(state: RunState): boolean`

- [ ] **Step 1: Write the failing state machine test**

`test/domain/state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	IllegalTransitionError,
	isTerminal,
	requiresHumanDecision,
	transition,
	type RunState,
} from "../../src/domain/state.js";

const legal: [RunState, RunState][] = [
	["RUNNING", "ENDED"],
	["ENDED", "VERIFYING"],
	["VERIFYING", "VERIFIED"],
	["VERIFYING", "FAILED"],
	["VERIFYING", "UNVERIFIED"],
	["VERIFIED", "AWAITING_APPROVAL"],
	["FAILED", "AWAITING_APPROVAL"],
	["UNVERIFIED", "AWAITING_APPROVAL"],
	["AWAITING_APPROVAL", "APPROVED"],
	["AWAITING_APPROVAL", "REJECTED"],
	["APPROVED", "RECORDED"],
	["VERIFIED", "RECORDED"],
];

const illegal: [RunState, RunState][] = [
	["RUNNING", "VERIFIED"],
	["ENDED", "APPROVED"],
	["REJECTED", "APPROVED"],
	["RECORDED", "RUNNING"],
	["FAILED", "RECORDED"],
];

describe("transition", () => {
	it.each(legal)("allows %s -> %s", (from, to) => {
		expect(transition(from, to)).toBe(to);
	});

	it.each(illegal)("rejects %s -> %s", (from, to) => {
		expect(() => transition(from, to)).toThrow(IllegalTransitionError);
	});

	it("names both states in the error message", () => {
		expect(() => transition("RUNNING", "VERIFIED")).toThrow(/RUNNING.*VERIFIED/);
	});
});

describe("classification", () => {
	it("treats RECORDED and REJECTED as terminal", () => {
		expect(isTerminal("RECORDED")).toBe(true);
		expect(isTerminal("REJECTED")).toBe(true);
		expect(isTerminal("VERIFIED")).toBe(false);
	});

	it("requires a human for failed and unverified runs regardless of score", () => {
		expect(requiresHumanDecision("FAILED")).toBe(true);
		expect(requiresHumanDecision("UNVERIFIED")).toBe(true);
		expect(requiresHumanDecision("VERIFIED")).toBe(false);
	});
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run test/domain/state.test.ts`
Expected: FAIL, cannot resolve `../../src/domain/state.js`.

- [ ] **Step 3: Write the state machine**

`src/domain/state.ts`:

```ts
export type RunState =
	| "RUNNING"
	| "ENDED"
	| "VERIFYING"
	| "VERIFIED"
	| "FAILED"
	| "UNVERIFIED"
	| "AWAITING_APPROVAL"
	| "APPROVED"
	| "REJECTED"
	| "RECORDED";

const ALLOWED: Readonly<Record<RunState, readonly RunState[]>> = {
	RUNNING: ["ENDED"],
	ENDED: ["VERIFYING"],
	VERIFYING: ["VERIFIED", "FAILED", "UNVERIFIED"],
	VERIFIED: ["AWAITING_APPROVAL", "RECORDED"],
	FAILED: ["AWAITING_APPROVAL"],
	UNVERIFIED: ["AWAITING_APPROVAL"],
	AWAITING_APPROVAL: ["APPROVED", "REJECTED"],
	APPROVED: ["RECORDED"],
	REJECTED: [],
	RECORDED: [],
};

export class IllegalTransitionError extends Error {
	constructor(from: RunState, to: RunState) {
		super(`illegal run transition ${from} -> ${to}`);
		this.name = "IllegalTransitionError";
	}
}

export function transition(from: RunState, to: RunState): RunState {
	if (!ALLOWED[from].includes(to)) throw new IllegalTransitionError(from, to);
	return to;
}

export function isTerminal(state: RunState): boolean {
	return ALLOWED[state].length === 0;
}

export function requiresHumanDecision(state: RunState): boolean {
	return state === "FAILED" || state === "UNVERIFIED";
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run test/domain/state.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/domain/state.ts test/domain/state.test.ts
git commit -m "feat: run state machine with explicit illegal transitions"
```

---

### Task 4: Run projection, the fold over events

**Files:**
- Create: `src/domain/run.ts`
- Test: `test/domain/run.test.ts`

**Interfaces:**
- Consumes: `AgentEvent` from Task 2, `RunState` from Task 3
- Produces: `AgentRun`, `ModelUsage`, `Claims`; `projectRun(runId: RunId, events: readonly AgentEvent[]): AgentRun`

- [ ] **Step 1: Write the failing projection test**

`test/domain/run.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AgentEvent, DraftEvent } from "../../src/domain/events.js";
import { projectRun } from "../../src/domain/run.js";

function log(...drafts: DraftEvent[]): AgentEvent[] {
	return drafts.map((draft, seq) => ({ ...draft, runId: 1, seq }));
}

function draft(kind: DraftEvent["kind"], payload: Record<string, unknown> = {}): DraftEvent {
	return { ts: "2026-09-09T10:00:00.000Z", source: "claude-code", kind, payload };
}

describe("projectRun", () => {
	it("starts a run from RunStarted", () => {
		const run = projectRun(1, log(draft("RunStarted", { task: "fix auth", baseSha: "abc" })));
		expect(run.state).toBe("RUNNING");
		expect(run.task).toBe("fix auth");
		expect(run.baseSha).toBe("abc");
	});

	it("collects mutated paths as claims without deduplicating order away", () => {
		const run = projectRun(
			1,
			log(
				draft("RunStarted", { task: "t", baseSha: "abc" }),
				draft("FileMutated", { path: "a.ts" }),
				draft("FileMutated", { path: "b.ts" }),
				draft("FileMutated", { path: "a.ts" }),
			),
		);
		expect(run.claims.mutatedPaths).toEqual(["a.ts", "b.ts"]);
	});

	it("accumulates model usage per assistant message", () => {
		const usage = { model: "claude-opus-5", input: 2, output: 410, cacheRead: 27536, cacheCreate: 45933 };
		const run = projectRun(
			1,
			log(draft("RunStarted", { task: "t", baseSha: "abc" }), draft("ModelUsageRecorded", usage)),
		);
		expect(run.usage).toEqual([usage]);
	});

	it("moves to ENDED and records the end sha", () => {
		const run = projectRun(
			1,
			log(draft("RunStarted", { task: "t", baseSha: "abc" }), draft("AgentStopped", { endSha: "def" })),
		);
		expect(run.state).toBe("ENDED");
		expect(run.endSha).toBe("def");
	});

	it("marks the run as gapped when a GapRecorded is present", () => {
		const run = projectRun(
			1,
			log(draft("RunStarted", { task: "t", baseSha: "abc" }), draft("GapRecorded", { reason: "socket down", lost: 3 })),
		);
		expect(run.hasGaps).toBe(true);
	});

	it("throws when the first event is not RunStarted", () => {
		expect(() => projectRun(1, log(draft("FileMutated", { path: "a.ts" })))).toThrow(/RunStarted/);
	});

	it("is a pure fold: replaying the same events yields an equal run", () => {
		const events = log(draft("RunStarted", { task: "t", baseSha: "abc" }), draft("FileMutated", { path: "a.ts" }));
		expect(projectRun(1, events)).toEqual(projectRun(1, events));
	});
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run test/domain/run.test.ts`
Expected: FAIL, cannot resolve `../../src/domain/run.js`.

- [ ] **Step 3: Write the projection**

`src/domain/run.ts`:

```ts
import type { AgentEvent, RunId } from "./events.js";
import { transition, type RunState } from "./state.js";

export type ModelUsage = {
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheCreate: number;
};

export type Claims = { mutatedPaths: string[]; commands: string[] };

export type AgentRun = {
	id: RunId;
	task: string;
	state: RunState;
	baseSha: string | null;
	endSha: string | null;
	startedAt: string;
	endedAt: string | null;
	hasGaps: boolean;
	claims: Claims;
	usage: ModelUsage[];
};

export function projectRun(id: RunId, events: readonly AgentEvent[]): AgentRun {
	const first = events[0];
	if (first?.kind !== "RunStarted") throw new Error(`run ${id} does not begin with RunStarted`);
	return events.reduce(apply, seedFrom(id, first));
}

function seedFrom(id: RunId, started: AgentEvent): AgentRun {
	return {
		id,
		task: String(started.payload.task ?? ""),
		state: "RUNNING",
		baseSha: asStringOrNull(started.payload.baseSha),
		endSha: null,
		startedAt: started.ts,
		endedAt: null,
		hasGaps: false,
		claims: { mutatedPaths: [], commands: [] },
		usage: [],
	};
}

function apply(run: AgentRun, event: AgentEvent): AgentRun {
	switch (event.kind) {
		case "RunStarted":
			return run;
		case "FileMutated":
			return { ...run, claims: withPath(run.claims, String(event.payload.path ?? "")) };
		case "CommandStarted":
			return { ...run, claims: withCommand(run.claims, String(event.payload.command ?? "")) };
		case "ModelUsageRecorded":
			return { ...run, usage: [...run.usage, readUsage(event.payload)] };
		case "GapRecorded":
			return { ...run, hasGaps: true };
		case "AgentStopped":
			return {
				...run,
				state: transition(run.state, "ENDED"),
				endedAt: event.ts,
				endSha: asStringOrNull(event.payload.endSha),
			};
		default:
			return run;
	}
}

function withPath(claims: Claims, path: string): Claims {
	if (path === "" || claims.mutatedPaths.includes(path)) return claims;
	return { ...claims, mutatedPaths: [...claims.mutatedPaths, path] };
}

function withCommand(claims: Claims, command: string): Claims {
	if (command === "") return claims;
	return { ...claims, commands: [...claims.commands, command] };
}

function readUsage(payload: Record<string, unknown>): ModelUsage {
	return {
		model: String(payload.model ?? "unknown"),
		input: Number(payload.input ?? 0),
		output: Number(payload.output ?? 0),
		cacheRead: Number(payload.cacheRead ?? 0),
		cacheCreate: Number(payload.cacheCreate ?? 0),
	};
}

function asStringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}
```

Later tasks extend `apply` with verification, risk and approval events. Adjudication state lives in `verdict.json` and `risk.json`; the fold owns lifecycle, claims and usage only.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run test/domain/run.test.ts`
Expected: PASS, seven tests.

- [ ] **Step 5: Add the purity guard test**

`test/domain/purity.test.ts`:

```ts
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN = [/from "node:fs/, /from "node:child_process/, /from "node:net/, /\.\.\/store\//, /\.\.\/git\//];

describe("domain purity", () => {
	it("imports no I/O and no impure modules", async () => {
		const dir = "src/domain";
		for (const file of await readdir(dir)) {
			if (!file.endsWith(".ts") || file === "checksum.ts") continue;
			const source = await readFile(join(dir, file), "utf8");
			for (const pattern of FORBIDDEN) {
				expect(source, `${file} must stay pure`).not.toMatch(pattern);
			}
		}
	});
});
```

`checksum.ts` is exempt because `node:crypto` is a pure computation with no I/O. Note that exemption in a one-line comment in the test.

- [ ] **Step 6: Run the purity test and confirm it passes**

Run: `pnpm vitest run test/domain/purity.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/run.ts test/domain/run.test.ts test/domain/purity.test.ts
git commit -m "feat: run projection as a pure fold over the event log"
```

---

### Task 5: Event log store

**Files:**
- Create: `src/store/paths.ts`
- Create: `src/store/eventLog.ts`
- Test: `test/store/eventLog.test.ts`

**Interfaces:**
- Consumes: `AgentEvent`, `DraftEvent`, `StoredEvent`, `checksumOf`, `verifyChecksum`
- Produces: `rptDirOf(repoRoot: string): string`; `runDirOf(rptDir: string, runId: RunId): string`; `appendEvent(rptDir: string, runId: RunId, draft: DraftEvent): Promise<AgentEvent>`; `readEvents(rptDir: string, runId: RunId): Promise<ReadResult>` where `ReadResult = { events: AgentEvent[]; gapCount: number }`

- [ ] **Step 1: Write the failing event log test**

`test/store/eventLog.test.ts`:

```ts
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { DraftEvent } from "../../src/domain/events.js";
import { appendEvent, readEvents } from "../../src/store/eventLog.js";
import { runDirOf } from "../../src/store/paths.js";

let rptDir = "";

function draft(kind: DraftEvent["kind"], payload: Record<string, unknown> = {}): DraftEvent {
	return { ts: "2026-09-09T10:00:00.000Z", source: "claude-code", kind, payload };
}

beforeEach(async () => {
	rptDir = await mkdtemp(join(tmpdir(), "rpt-log-"));
});

describe("appendEvent", () => {
	it("assigns sequence numbers starting at zero", async () => {
		const first = await appendEvent(rptDir, 1, draft("RunStarted", { task: "t" }));
		const second = await appendEvent(rptDir, 1, draft("FileMutated", { path: "a.ts" }));
		expect([first.seq, second.seq]).toEqual([0, 1]);
	});

	it("keeps sequence numbers independent per run", async () => {
		await appendEvent(rptDir, 1, draft("RunStarted"));
		const other = await appendEvent(rptDir, 2, draft("RunStarted"));
		expect(other.seq).toBe(0);
	});

	it("survives concurrent appends without losing or repeating a sequence", async () => {
		await Promise.all(
			Array.from({ length: 25 }, () => appendEvent(rptDir, 1, draft("FileMutated", { path: "a.ts" }))),
		);
		const { events } = await readEvents(rptDir, 1);
		expect(events.map((event) => event.seq)).toEqual([...Array(25).keys()]);
	});

	it("truncates an oversized payload and marks it", async () => {
		const event = await appendEvent(rptDir, 1, draft("CommandCompleted", { stdout: "x".repeat(20000) }));
		expect(event.payload.truncated).toBe(true);
		expect(JSON.stringify(event).length).toBeLessThan(9000);
	});
});

describe("readEvents", () => {
	it("round trips what was appended", async () => {
		await appendEvent(rptDir, 1, draft("RunStarted", { task: "fix auth" }));
		const { events, gapCount } = await readEvents(rptDir, 1);
		expect(gapCount).toBe(0);
		expect(events[0]?.payload.task).toBe("fix auth");
	});

	it("returns an empty result for a run that has no log", async () => {
		expect(await readEvents(rptDir, 99)).toEqual({ events: [], gapCount: 0 });
	});

	it("skips a torn trailing line and counts it as a gap", async () => {
		await appendEvent(rptDir, 1, draft("RunStarted", { task: "t" }));
		await appendFile(join(runDirOf(rptDir, 1), "events.jsonl"), '{"runId":1,"seq":1,"kind":"Fi');
		const { events, gapCount } = await readEvents(rptDir, 1);
		expect(events).toHaveLength(1);
		expect(gapCount).toBe(1);
	});

	it("rejects a line whose checksum no longer matches its payload", async () => {
		await appendEvent(rptDir, 1, draft("RunStarted", { task: "t" }));
		const path = join(runDirOf(rptDir, 1), "events.jsonl");
		const tampered = (await readFile(path, "utf8")).replace('"task":"t"', '"task":"evil"');
		await writeFile(path, tampered);
		const { events, gapCount } = await readEvents(rptDir, 1);
		expect(events).toHaveLength(0);
		expect(gapCount).toBe(1);
	});
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run test/store/eventLog.test.ts`
Expected: FAIL, cannot resolve `../../src/store/eventLog.js`.

- [ ] **Step 3: Write the path helpers**

`src/store/paths.ts`:

```ts
import { join } from "node:path";
import type { RunId } from "../domain/events.js";

export function rptDirOf(repoRoot: string): string {
	return join(repoRoot, ".rpt");
}

export function runDirOf(rptDir: string, runId: RunId): string {
	return join(rptDir, "runs", String(runId));
}

export function eventLogOf(rptDir: string, runId: RunId): string {
	return join(runDirOf(rptDir, runId), "events.jsonl");
}
```

- [ ] **Step 4: Write the event log**

`src/store/eventLog.ts`:

```ts
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { checksumOf, verifyChecksum } from "../domain/checksum.js";
import type { AgentEvent, DraftEvent, RunId, StoredEvent } from "../domain/events.js";
import { eventLogOf, runDirOf } from "./paths.js";

const MAX_PAYLOAD_BYTES = 8192;

export type ReadResult = { events: AgentEvent[]; gapCount: number };

export async function appendEvent(
	rptDir: string,
	runId: RunId,
	draft: DraftEvent,
): Promise<AgentEvent> {
	const path = eventLogOf(rptDir, runId);
	await mkdir(dirname(path), { recursive: true });
	await ensureExists(path);
	const release = await lockfile.lock(path, { retries: { retries: 10, minTimeout: 5, maxTimeout: 100 } });
	try {
		const event: AgentEvent = { ...draft, payload: capPayload(draft.payload), runId, seq: await nextSeq(path) };
		const stored: StoredEvent = { ...event, checksum: checksumOf(event) };
		await appendFile(path, `${JSON.stringify(stored)}\n`, "utf8");
		return event;
	} finally {
		await release();
	}
}

export async function readEvents(rptDir: string, runId: RunId): Promise<ReadResult> {
	const text = await readOrEmpty(eventLogOf(rptDir, runId));
	if (text === "") return { events: [], gapCount: 0 };
	const lines = text.split("\n").filter((line) => line !== "");
	const events: AgentEvent[] = [];
	let gapCount = 0;
	for (const line of lines) {
		const event = parseLine(line);
		if (event === null) gapCount += 1;
		else events.push(event);
	}
	return { events, gapCount };
}

function parseLine(line: string): AgentEvent | null {
	let stored: StoredEvent;
	try {
		stored = JSON.parse(line) as StoredEvent;
	} catch {
		return null;
	}
	if (!verifyChecksum(stored)) return null;
	const { checksum, ...event } = stored;
	return event;
}

function capPayload(payload: Record<string, unknown>): Record<string, unknown> {
	if (Buffer.byteLength(JSON.stringify(payload)) <= MAX_PAYLOAD_BYTES) return payload;
	const capped = Object.fromEntries(
		Object.entries(payload).map(([key, value]) => [key, capValue(value)]),
	);
	return { ...capped, truncated: true };
}

function capValue(value: unknown): unknown {
	if (typeof value !== "string" || Buffer.byteLength(value) <= 1024) return value;
	return `${value.slice(0, 1024)}...`;
}

async function nextSeq(path: string): Promise<number> {
	const text = await readOrEmpty(path);
	return text === "" ? 0 : text.split("\n").filter((line) => line !== "").length;
}

async function ensureExists(path: string): Promise<void> {
	try {
		await writeFile(path, "", { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

async function readOrEmpty(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}
```

Note the deliberate trade: `nextSeq` rereads the file under the lock rather than caching a counter. The daemon is normally the only writer, so this path is cheap, and correctness under the fallback writer matters more than the read.

Import `runDirOf` only if used; remove the unused import if the compiler flags it.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run test/store/eventLog.test.ts`
Expected: PASS, nine tests.

- [ ] **Step 6: Commit**

```bash
git add src/store test/store
git commit -m "feat: append-only checksummed event log with gap detection"
```

---

### Task 6: Run index

**Files:**
- Create: `src/store/runIndex.ts`
- Test: `test/store/runIndex.test.ts`

**Interfaces:**
- Consumes: `RunId`, `RunState`
- Produces: `RunIndexEntry`; `allocateRunId(rptDir: string): Promise<RunId>`; `upsertRun(rptDir: string, entry: RunIndexEntry): Promise<void>`; `listRuns(rptDir: string): Promise<RunIndexEntry[]>`; `activeRun(rptDir: string): Promise<RunIndexEntry | null>`

- [ ] **Step 1: Write the failing run index test**

`test/store/runIndex.test.ts`:

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { activeRun, allocateRunId, listRuns, upsertRun } from "../../src/store/runIndex.js";
import type { RunIndexEntry } from "../../src/store/runIndex.js";

let rptDir = "";

function entry(id: number, overrides: Partial<RunIndexEntry> = {}): RunIndexEntry {
	return {
		id,
		task: `task ${id}`,
		state: "RUNNING",
		startedAt: `2026-09-09T10:0${id}:00.000Z`,
		endedAt: null,
		...overrides,
	};
}

beforeEach(async () => {
	rptDir = await mkdtemp(join(tmpdir(), "rpt-index-"));
});

describe("allocateRunId", () => {
	it("starts at 1", async () => {
		expect(await allocateRunId(rptDir)).toBe(1);
	});

	it("never repeats an id under concurrency", async () => {
		const ids = await Promise.all(Array.from({ length: 20 }, () => allocateRunId(rptDir)));
		expect(new Set(ids).size).toBe(20);
	});
});

describe("listRuns", () => {
	it("returns newest first", async () => {
		await upsertRun(rptDir, entry(1));
		await upsertRun(rptDir, entry(2));
		expect((await listRuns(rptDir)).map((run) => run.id)).toEqual([2, 1]);
	});

	it("collapses an id to its latest write", async () => {
		await upsertRun(rptDir, entry(1));
		await upsertRun(rptDir, entry(1, { state: "ENDED" }));
		const runs = await listRuns(rptDir);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.state).toBe("ENDED");
	});
});

describe("activeRun", () => {
	it("is the newest run that has ended and has not been recorded", async () => {
		await upsertRun(rptDir, entry(1, { state: "RECORDED" }));
		await upsertRun(rptDir, entry(2, { state: "ENDED" }));
		expect((await activeRun(rptDir))?.id).toBe(2);
	});

	it("ignores runs that are still running", async () => {
		await upsertRun(rptDir, entry(1, { state: "RUNNING" }));
		expect(await activeRun(rptDir)).toBeNull();
	});

	it("is null when there are no runs at all", async () => {
		expect(await activeRun(rptDir)).toBeNull();
	});
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run test/store/runIndex.test.ts`
Expected: FAIL, cannot resolve `../../src/store/runIndex.js`.

- [ ] **Step 3: Write the run index**

`src/store/runIndex.ts`:

```ts
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { RunId } from "../domain/events.js";
import { isTerminal, type RunState } from "../domain/state.js";

export type RunIndexEntry = {
	id: RunId;
	task: string;
	state: RunState;
	startedAt: string;
	endedAt: string | null;
};

export async function allocateRunId(rptDir: string): Promise<RunId> {
	const path = await preparedIndex(rptDir);
	const release = await lockfile.lock(path, { retries: { retries: 20, minTimeout: 5, maxTimeout: 100 } });
	try {
		const highest = (await readEntries(path)).reduce((max, entry) => Math.max(max, entry.id), 0);
		const id = highest + 1;
		await appendFile(path, `${JSON.stringify(reserved(id))}\n`, "utf8");
		return id;
	} finally {
		await release();
	}
}

export async function upsertRun(rptDir: string, entry: RunIndexEntry): Promise<void> {
	const path = await preparedIndex(rptDir);
	const release = await lockfile.lock(path, { retries: { retries: 20, minTimeout: 5, maxTimeout: 100 } });
	try {
		await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
	} finally {
		await release();
	}
}

export async function listRuns(rptDir: string): Promise<RunIndexEntry[]> {
	const latest = new Map<RunId, RunIndexEntry>();
	for (const entry of await readEntries(join(rptDir, "index.jsonl"))) latest.set(entry.id, entry);
	return [...latest.values()].sort((left, right) => right.id - left.id);
}

export async function activeRun(rptDir: string): Promise<RunIndexEntry | null> {
	const candidates = (await listRuns(rptDir)).filter(isAdjudicable);
	return candidates[0] ?? null;
}

function isAdjudicable(entry: RunIndexEntry): boolean {
	return entry.state !== "RUNNING" && !isTerminal(entry.state);
}

function reserved(id: RunId): RunIndexEntry {
	return { id, task: "", state: "RUNNING", startedAt: new Date().toISOString(), endedAt: null };
}

async function preparedIndex(rptDir: string): Promise<string> {
	await mkdir(rptDir, { recursive: true });
	const path = join(rptDir, "index.jsonl");
	try {
		await writeFile(path, "", { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	return path;
}

async function readEntries(path: string): Promise<RunIndexEntry[]> {
	let text = "";
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return text
		.split("\n")
		.filter((line) => line !== "")
		.flatMap((line) => parseEntry(line));
}

function parseEntry(line: string): RunIndexEntry[] {
	try {
		return [JSON.parse(line) as RunIndexEntry];
	} catch {
		return [];
	}
}
```

`activeRun` deliberately excludes `RUNNING`: a run still in progress has no sealed end state, so nothing can be verified or gated about it yet.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run test/store/runIndex.test.ts`
Expected: PASS, seven tests.

- [ ] **Step 5: Commit**

```bash
git add src/store/runIndex.ts test/store/runIndex.test.ts
git commit -m "feat: run index with concurrent-safe id allocation"
```

---

### Task 7: Git snapshots and diffs

**Files:**
- Create: `src/git/exec.ts`
- Create: `src/git/snapshot.ts`
- Create: `src/git/diff.ts`
- Test: `test/git/snapshot.test.ts`
- Test: `test/git/diff.test.ts`
- Test: `test/support/fixtureRepo.ts`

**Interfaces:**
- Consumes: `RunId`
- Produces: `git(repo: string, args: string[], env?: Record<string, string>): Promise<string>`; `headSha(repo: string): Promise<string | null>`; `createSnapshot(repo: string, runId: RunId, label: "base" | "end"): Promise<string>`; `DiffEntry = { path: string; status: "A" | "M" | "D" | "R" }`; `diffNameStatus(repo: string, from: string, to: string): Promise<DiffEntry[]>`; `diffStat(repo: string, from: string, to: string): Promise<{ added: number; removed: number }>`; `makeFixtureRepo(): Promise<string>`

- [ ] **Step 1: Write the fixture repo helper**

`test/support/fixtureRepo.ts`:

```ts
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
```

- [ ] **Step 2: Write the failing snapshot test**

`test/git/snapshot.test.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "../../src/git/exec.js";
import { createSnapshot, headSha } from "../../src/git/snapshot.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

describe("createSnapshot", () => {
	it("captures uncommitted work as a commit object", async () => {
		const repo = await makeFixtureRepo();
		await writeFile(join(repo, "new.ts"), "export const a = 1;\n");
		const sha = await createSnapshot(repo, 1, "end");
		const listed = await git(repo, ["ls-tree", "--name-only", sha]);
		expect(listed.split("\n")).toContain("new.ts");
	});

	it("leaves the user's index untouched", async () => {
		const repo = await makeFixtureRepo();
		await writeFile(join(repo, "new.ts"), "export const a = 1;\n");
		await createSnapshot(repo, 1, "end");
		const staged = await git(repo, ["diff", "--cached", "--name-only"]);
		expect(staged).toBe("");
	});

	it("leaves the working tree untouched", async () => {
		const repo = await makeFixtureRepo();
		await writeFile(join(repo, "new.ts"), "export const a = 1;\n");
		await createSnapshot(repo, 1, "end");
		const status = await git(repo, ["status", "--porcelain"]);
		expect(status).toContain("new.ts");
	});

	it("stores the snapshot under a run-scoped ref", async () => {
		const repo = await makeFixtureRepo();
		const sha = await createSnapshot(repo, 7, "base");
		expect(await git(repo, ["rev-parse", "refs/rpt/runs/7/base"])).toBe(sha);
	});
});

describe("headSha", () => {
	it("returns the current commit", async () => {
		const repo = await makeFixtureRepo();
		expect(await headSha(repo)).toMatch(/^[0-9a-f]{40}$/);
	});

	it("returns null in a repo with no commits", async () => {
		const repo = await makeFixtureRepo();
		await git(repo, ["checkout", "-q", "--orphan", "empty"]);
		await git(repo, ["rm", "-rq", "--cached", "."]);
		expect(await headSha(repo)).toBeNull();
	});
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `pnpm vitest run test/git/snapshot.test.ts`
Expected: FAIL, cannot resolve `../../src/git/exec.js`.

- [ ] **Step 4: Write the git executor**

`src/git/exec.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export class GitError extends Error {
	constructor(args: string[], stderr: string) {
		super(`git ${args.join(" ")} failed: ${stderr.trim()}`);
		this.name = "GitError";
	}
}

export async function git(
	repo: string,
	args: string[],
	env: Record<string, string> = {},
): Promise<string> {
	try {
		const { stdout } = await run("git", args, {
			cwd: repo,
			env: { ...process.env, ...env },
			maxBuffer: 64 * 1024 * 1024,
		});
		return stdout.trimEnd();
	} catch (error) {
		throw new GitError(args, String((error as { stderr?: string }).stderr ?? (error as Error).message));
	}
}
```

- [ ] **Step 5: Write the snapshot module**

`src/git/snapshot.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunId } from "../domain/events.js";
import { git, GitError } from "./exec.js";

export type SnapshotLabel = "base" | "end";

export async function headSha(repo: string): Promise<string | null> {
	try {
		return await git(repo, ["rev-parse", "HEAD"]);
	} catch (error) {
		if (error instanceof GitError) return null;
		throw error;
	}
}

export async function createSnapshot(
	repo: string,
	runId: RunId,
	label: SnapshotLabel,
): Promise<string> {
	const scratch = await mkdtemp(join(tmpdir(), "rpt-index-"));
	const env = { GIT_INDEX_FILE: join(scratch, "index") };
	try {
		await git(repo, ["add", "-A"], env);
		const tree = await git(repo, ["write-tree"], env);
		const sha = await commitTree(repo, tree);
		await git(repo, ["update-ref", refFor(runId, label), sha]);
		return sha;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

export function refFor(runId: RunId, label: SnapshotLabel): string {
	return `refs/rpt/runs/${runId}/${label}`;
}

async function commitTree(repo: string, tree: string): Promise<string> {
	const parent = await headSha(repo);
	const args = ["commit-tree", tree, "-m", "rpt snapshot"];
	return git(repo, parent === null ? args : [...args, "-p", parent]);
}
```

`GIT_INDEX_FILE` pointing at a scratch path is what keeps the user's staging area untouched. This is the single most important detail in the module.

- [ ] **Step 6: Run the snapshot test and confirm it passes**

Run: `pnpm vitest run test/git/snapshot.test.ts`
Expected: PASS, six tests.

- [ ] **Step 7: Write the failing diff test**

`test/git/diff.test.ts`:

```ts
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffNameStatus, diffStat } from "../../src/git/diff.js";
import { createSnapshot } from "../../src/git/snapshot.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

describe("diffNameStatus", () => {
	it("reports additions, modifications and deletions", async () => {
		const repo = await makeFixtureRepo();
		const base = await createSnapshot(repo, 1, "base");
		await writeFile(join(repo, "added.ts"), "export const a = 1;\n");
		await writeFile(join(repo, "README.md"), "changed\n");
		await rm(join(repo, "README.md"));
		await writeFile(join(repo, "README.md"), "changed\n");
		const end = await createSnapshot(repo, 1, "end");
		const entries = await diffNameStatus(repo, base, end);
		expect(entries).toEqual(
			expect.arrayContaining([
				{ path: "added.ts", status: "A" },
				{ path: "README.md", status: "M" },
			]),
		);
	});

	it("is empty when nothing changed", async () => {
		const repo = await makeFixtureRepo();
		const base = await createSnapshot(repo, 1, "base");
		const end = await createSnapshot(repo, 1, "end");
		expect(await diffNameStatus(repo, base, end)).toEqual([]);
	});
});

describe("diffStat", () => {
	it("counts added and removed lines", async () => {
		const repo = await makeFixtureRepo();
		const base = await createSnapshot(repo, 1, "base");
		await writeFile(join(repo, "added.ts"), "a\nb\nc\n");
		const end = await createSnapshot(repo, 1, "end");
		expect(await diffStat(repo, base, end)).toEqual({ added: 3, removed: 0 });
	});
});
```

- [ ] **Step 8: Write the diff module**

`src/git/diff.ts`:

```ts
import { git } from "./exec.js";

export type DiffStatus = "A" | "M" | "D" | "R";
export type DiffEntry = { path: string; status: DiffStatus };

export async function diffNameStatus(
	repo: string,
	from: string,
	to: string,
): Promise<DiffEntry[]> {
	const output = await git(repo, ["diff", "--name-status", "-M", from, to]);
	if (output === "") return [];
	return output.split("\n").map(toEntry);
}

export async function diffStat(
	repo: string,
	from: string,
	to: string,
): Promise<{ added: number; removed: number }> {
	const output = await git(repo, ["diff", "--numstat", from, to]);
	if (output === "") return { added: 0, removed: 0 };
	return output.split("\n").reduce(accumulate, { added: 0, removed: 0 });
}

export async function diffPatch(repo: string, from: string, to: string): Promise<string> {
	return git(repo, ["diff", "--unified=3", from, to]);
}

function toEntry(line: string): DiffEntry {
	const [rawStatus = "M", path = "", renamed] = line.split("\t");
	const status = rawStatus.charAt(0) as DiffStatus;
	return { path: status === "R" ? (renamed ?? path) : path, status };
}

function accumulate(
	totals: { added: number; removed: number },
	line: string,
): { added: number; removed: number } {
	const [added = "0", removed = "0"] = line.split("\t");
	return {
		added: totals.added + numberOf(added),
		removed: totals.removed + numberOf(removed),
	};
}

function numberOf(field: string): number {
	return field === "-" ? 0 : Number(field);
}
```

`diffPatch` is used by Plan 2's diff screen and security verifier. It is defined here so the git module stays the only caller of the git binary.

- [ ] **Step 9: Run both git tests and confirm they pass**

Run: `pnpm vitest run test/git`
Expected: PASS, nine tests.

- [ ] **Step 10: Commit**

```bash
git add src/git test/git test/support
git commit -m "feat: git snapshots via temporary index, plus diff helpers"
```

---

### Task 8: Claude Code adapter

**Files:**
- Create: `test/fixtures/hooks/README.md`
- Create: `src/collectors/AgentAdapter.ts`
- Create: `src/collectors/claudeCode.ts`
- Test: `test/collectors/claudeCode.test.ts`

**Interfaces:**
- Consumes: `DraftEvent`, `AgentRun`
- Produces: `AgentAdapter` interface; `claudeCodeAdapter: AgentAdapter`; `normalize(raw: unknown): DraftEvent[]`

**Why this task starts by capturing data:** the exact shape of a Claude Code hook payload is not something to reconstruct from memory. Capture real payloads first, then write the parser against them.

- [ ] **Step 1: Capture real hook payloads**

Create a throwaway recorder and point a scratch Claude Code project at it.

```bash
mkdir -p /tmp/rpt-capture && cat > /tmp/rpt-capture/record.sh <<'EOF'
#!/bin/sh
cat >> /tmp/rpt-capture/payloads.jsonl
exit 0
EOF
chmod +x /tmp/rpt-capture/record.sh
```

In a scratch directory, add `.claude/settings.json` registering `/tmp/rpt-capture/record.sh` for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `Stop`. Run one trivial Claude Code session in that directory that reads a file and edits a file. Then:

```bash
wc -l /tmp/rpt-capture/payloads.jsonl
head -1 /tmp/rpt-capture/payloads.jsonl | python3 -m json.tool
```

Copy the captured lines into `test/fixtures/hooks/`, one file per hook event name, with any absolute paths rewritten to `/fixture/repo` and any prompt text replaced with `fixture prompt`. Write `test/fixtures/hooks/README.md` recording the Claude Code version they were captured from and the date. Every field the parser reads must be present in a fixture. If a field you expected is absent, the parser must not read it.

- [ ] **Step 2: Write the failing adapter test**

`test/collectors/claudeCode.test.ts`. Load each captured fixture and assert on it. The assertions below use the field names the fixtures confirm; if a captured payload names a field differently, change the test to match the fixture, never the other way round.

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../../src/collectors/claudeCode.js";

async function fixture(name: string): Promise<unknown> {
	return JSON.parse(await readFile(join("test/fixtures/hooks", `${name}.json`), "utf8"));
}

describe("claudeCodeAdapter.normalize", () => {
	it("turns SessionStart into RunStarted carrying the transcript path", async () => {
		const [event] = claudeCodeAdapter.normalize(await fixture("SessionStart"));
		expect(event?.kind).toBe("RunStarted");
		expect(event?.payload.transcriptPath).toEqual(expect.stringContaining(".jsonl"));
	});

	it("turns UserPromptSubmit into PromptSubmitted", async () => {
		const [event] = claudeCodeAdapter.normalize(await fixture("UserPromptSubmit"));
		expect(event?.kind).toBe("PromptSubmitted");
	});

	it("turns PreToolUse into ToolCallStarted naming the tool", async () => {
		const [event] = claudeCodeAdapter.normalize(await fixture("PreToolUse"));
		expect(event?.kind).toBe("ToolCallStarted");
		expect(typeof event?.payload.tool).toBe("string");
	});

	it("emits FileMutated alongside ToolCallCompleted for a write tool", async () => {
		const events = claudeCodeAdapter.normalize(await fixture("PostToolUse.Edit"));
		expect(events.map((event) => event.kind)).toEqual(
			expect.arrayContaining(["ToolCallCompleted", "FileMutated"]),
		);
	});

	it("emits CommandCompleted for a Bash tool result", async () => {
		const events = claudeCodeAdapter.normalize(await fixture("PostToolUse.Bash"));
		expect(events.map((event) => event.kind)).toContain("CommandCompleted");
	});

	it("turns Stop into AgentStopped", async () => {
		const [event] = claudeCodeAdapter.normalize(await fixture("Stop"));
		expect(event?.kind).toBe("AgentStopped");
	});

	it("returns no events for an unrecognised payload instead of throwing", () => {
		expect(claudeCodeAdapter.normalize({ hook_event_name: "SomethingNew" })).toEqual([]);
	});

	it("returns no events for a non-object payload instead of throwing", () => {
		expect(claudeCodeAdapter.normalize("not json")).toEqual([]);
	});

	it("marks every event as sourced from claude-code", async () => {
		const events = claudeCodeAdapter.normalize(await fixture("PostToolUse.Edit"));
		expect(events.every((event) => event.source === "claude-code")).toBe(true);
	});
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `pnpm vitest run test/collectors/claudeCode.test.ts`
Expected: FAIL, cannot resolve `../../src/collectors/claudeCode.js`.

- [ ] **Step 4: Write the adapter interface**

`src/collectors/AgentAdapter.ts`:

```ts
import type { DraftEvent } from "../domain/events.js";
import type { AgentRun } from "../domain/run.js";

export interface AgentAdapter {
	readonly id: string;
	install(repoRoot: string): Promise<void>;
	uninstall(repoRoot: string): Promise<void>;
	normalize(raw: unknown): DraftEvent[];
	enrich(run: AgentRun, context: { transcriptPath: string | null }): Promise<DraftEvent[]>;
}
```

- [ ] **Step 5: Write the adapter**

`src/collectors/claudeCode.ts`. Adjust every field name to match the captured fixtures.

```ts
import type { DraftEvent, EventKind } from "../domain/events.js";
import type { AgentAdapter } from "./AgentAdapter.js";
import { installHooks, uninstallHooks } from "./claudeCodeHooks.js";
import { readTranscriptUsage } from "./transcript.js";

const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

export const claudeCodeAdapter: AgentAdapter = {
	id: "claude-code",
	install: installHooks,
	uninstall: uninstallHooks,
	normalize,
	async enrich(_run, context) {
		if (context.transcriptPath === null) return [];
		return readTranscriptUsage(context.transcriptPath);
	},
};

export function normalize(raw: unknown): DraftEvent[] {
	if (raw === null || typeof raw !== "object") return [];
	const payload = raw as Record<string, unknown>;
	const hook = String(payload.hook_event_name ?? "");
	switch (hook) {
		case "SessionStart":
			return [event("RunStarted", { transcriptPath: payload.transcript_path ?? null, cwd: payload.cwd ?? null })];
		case "UserPromptSubmit":
			return [event("PromptSubmitted", { prompt: payload.prompt ?? "" })];
		case "PreToolUse":
			return [event("ToolCallStarted", { tool: payload.tool_name ?? "", input: payload.tool_input ?? {} })];
		case "PostToolUse":
			return postToolUse(payload);
		case "Stop":
			return [event("AgentStopped", {})];
		default:
			return [];
	}
}

function postToolUse(payload: Record<string, unknown>): DraftEvent[] {
	const tool = String(payload.tool_name ?? "");
	const completed = event("ToolCallCompleted", { tool, response: payload.tool_response ?? {} });
	if (WRITE_TOOLS.has(tool)) return [completed, ...mutations(payload)];
	if (tool === "Bash") return [completed, event("CommandCompleted", { command: commandOf(payload) })];
	return [completed];
}

function mutations(payload: Record<string, unknown>): DraftEvent[] {
	const input = (payload.tool_input ?? {}) as Record<string, unknown>;
	const path = input.file_path ?? input.notebook_path;
	if (typeof path !== "string") return [];
	return [event("FileMutated", { path, operation: "write" })];
}

function commandOf(payload: Record<string, unknown>): string {
	const input = (payload.tool_input ?? {}) as Record<string, unknown>;
	return String(input.command ?? "");
}

function event(kind: EventKind, body: Record<string, unknown>): DraftEvent {
	return { ts: new Date().toISOString(), source: "claude-code", kind, payload: body };
}
```

`installHooks`, `uninstallHooks` and `readTranscriptUsage` are written in Tasks 11 and 13. Stub them as functions that throw `new Error("not implemented")` for now so this task compiles, and delete the stubs in those tasks.

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm vitest run test/collectors/claudeCode.test.ts`
Expected: PASS, nine tests.

- [ ] **Step 7: Commit**

```bash
git add src/collectors test/collectors test/fixtures
git commit -m "feat: claude code hook adapter built against captured payloads"
```

---

### Task 9: Collector daemon and hook client

**Files:**
- Create: `src/daemon/protocol.ts`
- Create: `src/daemon/server.ts`
- Create: `src/daemon/client.ts`
- Test: `test/daemon/roundTrip.test.ts`

**Interfaces:**
- Consumes: `appendEvent`, `DraftEvent`, `RunId`
- Produces: `startDaemon(rptDir: string): Promise<Daemon>` where `Daemon = { socketPath: string; close(): Promise<void> }`; `sendEvent(socketPath: string, runId: RunId, draft: DraftEvent): Promise<boolean>`; `deliver(rptDir: string, runId: RunId, draft: DraftEvent): Promise<"socket" | "direct" | "dropped">`

- [ ] **Step 1: Write the failing daemon test**

`test/daemon/roundTrip.test.ts`:

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DraftEvent } from "../../src/domain/events.js";
import { deliver, sendEvent } from "../../src/daemon/client.js";
import { startDaemon, type Daemon } from "../../src/daemon/server.js";
import { readEvents } from "../../src/store/eventLog.js";

let rptDir = "";
let daemon: Daemon | null = null;

const draft: DraftEvent = {
	ts: "2026-09-09T10:00:00.000Z",
	source: "claude-code",
	kind: "FileMutated",
	payload: { path: "a.ts" },
};

beforeEach(async () => {
	rptDir = await mkdtemp(join(tmpdir(), "rpt-daemon-"));
});

afterEach(async () => {
	await daemon?.close();
	daemon = null;
});

describe("daemon round trip", () => {
	it("persists an event sent over the socket", async () => {
		daemon = await startDaemon(rptDir);
		expect(await sendEvent(daemon.socketPath, 1, draft)).toBe(true);
		const { events } = await readEvents(rptDir, 1);
		expect(events[0]?.payload.path).toBe("a.ts");
	});

	it("handles many events without reordering them", async () => {
		daemon = await startDaemon(rptDir);
		for (let index = 0; index < 30; index += 1) {
			await sendEvent(daemon.socketPath, 1, { ...draft, payload: { path: `f${index}.ts` } });
		}
		const { events } = await readEvents(rptDir, 1);
		expect(events.map((event) => event.payload.path)).toEqual(
			Array.from({ length: 30 }, (_, index) => `f${index}.ts`),
		);
	});

	it("reports failure rather than throwing when nothing is listening", async () => {
		expect(await sendEvent(join(rptDir, "absent.sock"), 1, draft)).toBe(false);
	});
});

describe("deliver", () => {
	it("uses the socket when the daemon is up", async () => {
		daemon = await startDaemon(rptDir);
		expect(await deliver(rptDir, 1, draft)).toBe("socket");
	});

	it("falls back to a direct append when the daemon is down", async () => {
		expect(await deliver(rptDir, 1, draft)).toBe("direct");
		const { events } = await readEvents(rptDir, 1);
		expect(events).toHaveLength(1);
	});

	it("records a gap when both paths fail", async () => {
		const unwritable = "/proc/nonexistent/rpt";
		expect(await deliver(unwritable, 1, draft)).toBe("dropped");
	});
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run test/daemon/roundTrip.test.ts`
Expected: FAIL, cannot resolve `../../src/daemon/client.js`.

- [ ] **Step 3: Write the wire protocol**

`src/daemon/protocol.ts`:

```ts
import { join } from "node:path";
import type { DraftEvent, RunId } from "../domain/events.js";

export type Frame = { runId: RunId; draft: DraftEvent };

export function socketPathOf(rptDir: string): string {
	return join(rptDir, "daemon.sock");
}

export function encode(frame: Frame): string {
	return `${JSON.stringify(frame)}\n`;
}

export function decode(line: string): Frame | null {
	try {
		const frame = JSON.parse(line) as Frame;
		return typeof frame.runId === "number" && typeof frame.draft?.kind === "string" ? frame : null;
	} catch {
		return null;
	}
}
```

- [ ] **Step 4: Write the server**

`src/daemon/server.ts`:

```ts
import { createServer, type Server, type Socket } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { appendEvent } from "../store/eventLog.js";
import { decode, socketPathOf } from "./protocol.js";

export type Daemon = { socketPath: string; close(): Promise<void> };

export async function startDaemon(rptDir: string): Promise<Daemon> {
	await mkdir(rptDir, { recursive: true });
	const socketPath = socketPathOf(rptDir);
	await rm(socketPath, { force: true });
	const server = createServer((socket) => handle(rptDir, socket));
	await listen(server, socketPath);
	return { socketPath, close: () => close(server, socketPath) };
}

function handle(rptDir: string, socket: Socket): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		void persistAll(rptDir, lines, socket);
	});
	socket.on("error", () => socket.destroy());
}

async function persistAll(rptDir: string, lines: string[], socket: Socket): Promise<void> {
	for (const line of lines) {
		const frame = decode(line);
		if (frame === null) continue;
		try {
			await appendEvent(rptDir, frame.runId, frame.draft);
		} catch (error) {
			process.stderr.write(`rpt daemon: append failed: ${(error as Error).message}\n`);
		}
	}
	socket.write("ok\n");
}

function listen(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});
}

async function close(server: Server, socketPath: string): Promise<void> {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await rm(socketPath, { force: true });
}
```

The daemon writes its append failures to stderr rather than swallowing them. It never throws back at the client, because a client throw would surface inside the agent.

- [ ] **Step 5: Write the client**

`src/daemon/client.ts`:

```ts
import { connect } from "node:net";
import type { DraftEvent, RunId } from "../domain/events.js";
import { appendEvent } from "../store/eventLog.js";
import { encode, socketPathOf } from "./protocol.js";

const SEND_TIMEOUT_MS = 200;

export type Delivery = "socket" | "direct" | "dropped";

export async function deliver(rptDir: string, runId: RunId, draft: DraftEvent): Promise<Delivery> {
	if (await sendEvent(socketPathOf(rptDir), runId, draft)) return "socket";
	if (await appendDirectly(rptDir, runId, draft)) return "direct";
	return "dropped";
}

export function sendEvent(socketPath: string, runId: RunId, draft: DraftEvent): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(socketPath);
		const settle = (delivered: boolean): void => {
			socket.destroy();
			resolve(delivered);
		};
		socket.setTimeout(SEND_TIMEOUT_MS, () => settle(false));
		socket.on("error", () => settle(false));
		socket.on("connect", () => socket.write(encode({ runId, draft })));
		socket.on("data", () => settle(true));
	});
}

async function appendDirectly(rptDir: string, runId: RunId, draft: DraftEvent): Promise<boolean> {
	try {
		await appendEvent(rptDir, runId, draft);
		return true;
	} catch {
		return false;
	}
}

export async function deliverOrRecordGap(
	rptDir: string,
	runId: RunId,
	draft: DraftEvent,
): Promise<Delivery> {
	const delivery = await deliver(rptDir, runId, draft);
	if (delivery !== "dropped") return delivery;
	await appendDirectly(rptDir, runId, {
		ts: new Date().toISOString(),
		source: "rpt",
		kind: "GapRecorded",
		payload: { reason: "event delivery failed", lost: 1, kind: draft.kind },
	});
	return "dropped";
}
```

`appendDirectly` is the one place a catch returns a boolean rather than rethrowing. That is deliberate and is the mechanism behind the never-break-the-agent rule. The loss is not silent: `deliverOrRecordGap` turns it into a `GapRecorded`, and a gapped run can never be VERIFIED.

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm vitest run test/daemon/roundTrip.test.ts`
Expected: PASS, six tests.

- [ ] **Step 7: Commit**

```bash
git add src/daemon test/daemon
git commit -m "feat: collector daemon with direct-append fallback and gap recording"
```

---

### Task 10: Run lifecycle use cases and the hook entry point

**Files:**
- Create: `src/app/startRun.ts`
- Create: `src/app/recordEvent.ts`
- Create: `src/app/endRun.ts`
- Create: `src/app/loadRun.ts`
- Create: `src/cli/hook.ts`
- Test: `test/app/lifecycle.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4 to 9
- Produces: `startRun(repoRoot: string, input: { task: string; transcriptPath: string | null }): Promise<AgentRun>`; `recordEvent(repoRoot: string, draft: DraftEvent): Promise<void>`; `endRun(repoRoot: string): Promise<AgentRun>`; `loadRun(repoRoot: string, runId: RunId): Promise<AgentRun>`; `handleHook(repoRoot: string, raw: unknown): Promise<void>`

- [ ] **Step 1: Write the failing lifecycle test**

`test/app/lifecycle.test.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { endRun } from "../../src/app/endRun.js";
import { loadRun } from "../../src/app/loadRun.js";
import { recordEvent } from "../../src/app/recordEvent.js";
import { startRun } from "../../src/app/startRun.js";
import { activeRun } from "../../src/store/runIndex.js";
import { rptDirOf } from "../../src/store/paths.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

describe("run lifecycle", () => {
	it("starts a run, records the base sha and leaves it RUNNING", async () => {
		const repo = await makeFixtureRepo();
		const run = await startRun(repo, { task: "fix auth", transcriptPath: null });
		expect(run.id).toBe(1);
		expect(run.state).toBe("RUNNING");
		expect(run.baseSha).toMatch(/^[0-9a-f]{40}$/);
	});

	it("records agent claims into the log", async () => {
		const repo = await makeFixtureRepo();
		await startRun(repo, { task: "t", transcriptPath: null });
		await recordEvent(repo, {
			ts: "2026-09-09T10:01:00.000Z",
			source: "claude-code",
			kind: "FileMutated",
			payload: { path: "a.ts" },
		});
		const run = await loadRun(repo, 1);
		expect(run.claims.mutatedPaths).toEqual(["a.ts"]);
	});

	it("ends a run, snapshots uncommitted work and becomes the active run", async () => {
		const repo = await makeFixtureRepo();
		await startRun(repo, { task: "t", transcriptPath: null });
		await writeFile(join(repo, "new.ts"), "export const a = 1;\n");
		const ended = await endRun(repo);
		expect(ended.state).toBe("ENDED");
		expect(ended.endSha).toMatch(/^[0-9a-f]{40}$/);
		expect((await activeRun(rptDirOf(repo)))?.id).toBe(1);
	});

	it("refuses to end a run when none is running", async () => {
		const repo = await makeFixtureRepo();
		await expect(endRun(repo)).rejects.toThrow(/no run in progress/i);
	});

	it("numbers a second run independently", async () => {
		const repo = await makeFixtureRepo();
		await startRun(repo, { task: "one", transcriptPath: null });
		await endRun(repo);
		const second = await startRun(repo, { task: "two", transcriptPath: null });
		expect(second.id).toBe(2);
	});
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run test/app/lifecycle.test.ts`
Expected: FAIL, cannot resolve `../../src/app/endRun.js`.

- [ ] **Step 3: Write the current-run pointer and loader**

`src/app/loadRun.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunId } from "../domain/events.js";
import { projectRun, type AgentRun } from "../domain/run.js";
import { readEvents } from "../store/eventLog.js";
import { rptDirOf } from "../store/paths.js";

export async function loadRun(repoRoot: string, runId: RunId): Promise<AgentRun> {
	const { events, gapCount } = await readEvents(rptDirOf(repoRoot), runId);
	const run = projectRun(runId, events);
	return gapCount > 0 ? { ...run, hasGaps: true } : run;
}

export async function currentRunId(repoRoot: string): Promise<RunId | null> {
	try {
		const raw = await readFile(join(rptDirOf(repoRoot), "current"), "utf8");
		const id = Number(raw.trim());
		return Number.isInteger(id) ? id : null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export async function setCurrentRunId(repoRoot: string, runId: RunId | null): Promise<void> {
	const path = join(rptDirOf(repoRoot), "current");
	await writeFile(path, runId === null ? "" : String(runId), "utf8");
}
```

- [ ] **Step 4: Write startRun**

`src/app/startRun.ts`:

```ts
import { mkdir } from "node:fs/promises";
import { createSnapshot, headSha } from "../git/snapshot.js";
import type { AgentRun } from "../domain/run.js";
import { appendEvent } from "../store/eventLog.js";
import { rptDirOf } from "../store/paths.js";
import { allocateRunId, upsertRun } from "../store/runIndex.js";
import { loadRun, setCurrentRunId } from "./loadRun.js";

export type StartRunInput = { task: string; transcriptPath: string | null };

export async function startRun(repoRoot: string, input: StartRunInput): Promise<AgentRun> {
	const rptDir = rptDirOf(repoRoot);
	await mkdir(rptDir, { recursive: true });
	const runId = await allocateRunId(rptDir);
	const baseSha = await createSnapshot(repoRoot, runId, "base");
	const startedAt = new Date().toISOString();
	await appendEvent(rptDir, runId, {
		ts: startedAt,
		source: "rpt",
		kind: "RunStarted",
		payload: { task: input.task, baseSha, headSha: await headSha(repoRoot), transcriptPath: input.transcriptPath },
	});
	await upsertRun(rptDir, { id: runId, task: input.task, state: "RUNNING", startedAt, endedAt: null });
	await setCurrentRunId(repoRoot, runId);
	return loadRun(repoRoot, runId);
}
```

- [ ] **Step 5: Write recordEvent and endRun**

`src/app/recordEvent.ts`:

```ts
import type { DraftEvent } from "../domain/events.js";
import { deliverOrRecordGap } from "../daemon/client.js";
import { rptDirOf } from "../store/paths.js";
import { currentRunId } from "./loadRun.js";

export async function recordEvent(repoRoot: string, draft: DraftEvent): Promise<void> {
	const runId = await currentRunId(repoRoot);
	if (runId === null) return;
	await deliverOrRecordGap(rptDirOf(repoRoot), runId, draft);
}
```

`src/app/endRun.ts`:

```ts
import { createSnapshot } from "../git/snapshot.js";
import type { AgentRun } from "../domain/run.js";
import { appendEvent } from "../store/eventLog.js";
import { rptDirOf } from "../store/paths.js";
import { upsertRun } from "../store/runIndex.js";
import { currentRunId, loadRun, setCurrentRunId } from "./loadRun.js";

export async function endRun(repoRoot: string): Promise<AgentRun> {
	const runId = await currentRunId(repoRoot);
	if (runId === null) throw new Error("no run in progress for this repository");
	const rptDir = rptDirOf(repoRoot);
	const endSha = await createSnapshot(repoRoot, runId, "end");
	const endedAt = new Date().toISOString();
	await appendEvent(rptDir, runId, {
		ts: endedAt,
		source: "rpt",
		kind: "AgentStopped",
		payload: { endSha },
	});
	const run = await loadRun(repoRoot, runId);
	await upsertRun(rptDir, { id: runId, task: run.task, state: "ENDED", startedAt: run.startedAt, endedAt });
	await setCurrentRunId(repoRoot, null);
	return run;
}
```

- [ ] **Step 6: Write the hook entry point**

`src/cli/hook.ts`:

```ts
import { claudeCodeAdapter } from "../collectors/claudeCode.js";
import { endRun } from "../app/endRun.js";
import { recordEvent } from "../app/recordEvent.js";
import { startRun } from "../app/startRun.js";

export async function handleHook(repoRoot: string, raw: unknown): Promise<void> {
	for (const draft of claudeCodeAdapter.normalize(raw)) {
		if (draft.kind === "RunStarted") {
			await startRun(repoRoot, {
				task: String(draft.payload.task ?? "agent session"),
				transcriptPath: asStringOrNull(draft.payload.transcriptPath),
			});
			continue;
		}
		if (draft.kind === "AgentStopped") {
			await endRun(repoRoot);
			continue;
		}
		await recordEvent(repoRoot, draft);
	}
}

export async function runHookCommand(repoRoot: string, stdin: string): Promise<number> {
	try {
		await handleHook(repoRoot, JSON.parse(stdin));
	} catch (error) {
		process.stderr.write(`rpt hook: ${(error as Error).message}\n`);
	}
	return 0;
}

function asStringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}
```

`runHookCommand` always returns exit code 0. A hook that fails the agent is worse than a hook that misses an event, and the miss is already recorded as a gap.

- [ ] **Step 7: Run the test and confirm it passes**

Run: `pnpm vitest run test/app/lifecycle.test.ts`
Expected: PASS, five tests.

- [ ] **Step 8: Commit**

```bash
git add src/app src/cli/hook.ts test/app
git commit -m "feat: run lifecycle use cases and non-failing hook entry point"
```

---

### Task 11: rpt init

**Files:**
- Create: `src/collectors/claudeCodeHooks.ts`
- Create: `src/app/initRepo.ts`
- Test: `test/app/initRepo.test.ts`

**Interfaces:**
- Consumes: `RptConfig`, `makeFixtureRepo`
- Produces: `installHooks(repoRoot: string): Promise<void>`; `uninstallHooks(repoRoot: string): Promise<void>`; `initRepo(repoRoot: string): Promise<InitReport>` where `InitReport = { hooksInstalled: boolean; gitignoreUpdated: boolean; configCreated: boolean; pricingCreated: boolean }`

- [ ] **Step 1: Write the failing init test**

`test/app/initRepo.test.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initRepo } from "../../src/app/initRepo.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

async function read(repo: string, path: string): Promise<string> {
	return readFile(join(repo, path), "utf8");
}

describe("initRepo", () => {
	it("registers rpt hook for every collected claude code event", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		const settings = JSON.parse(await read(repo, ".claude/settings.json"));
		expect(Object.keys(settings.hooks).sort()).toEqual(
			["PostToolUse", "PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"],
		);
	});

	it("preserves hooks that were already configured", async () => {
		const repo = await makeFixtureRepo();
		await writeFile(
			join(repo, ".claude/settings.json"),
			JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "existing" }] }] } }),
		).catch(async () => {
			await initRepo(repo);
		});
		await initRepo(repo);
		const settings = JSON.parse(await read(repo, ".claude/settings.json"));
		const commands = JSON.stringify(settings.hooks.PreToolUse);
		expect(commands).toContain("rpt hook");
	});

	it("adds .rpt to gitignore exactly once across repeated runs", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		await initRepo(repo);
		const ignored = await read(repo, ".gitignore");
		expect(ignored.match(/^\.rpt\/$/gm)).toHaveLength(1);
	});

	it("creates a config file that loadConfig accepts", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		expect(JSON.parse(await read(repo, "rpt.config.json"))).toHaveProperty("thresholds");
	});

	it("creates a pricing file with no invented rates", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		const pricing = JSON.parse(await read(repo, ".rpt/pricing.json"));
		expect(pricing.version).toBe(1);
		expect(Object.values(pricing.rates)).toEqual([]);
	});

	it("is idempotent", async () => {
		const repo = await makeFixtureRepo();
		const first = await initRepo(repo);
		const second = await initRepo(repo);
		expect(first.hooksInstalled).toBe(true);
		expect(second.configCreated).toBe(false);
	});
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run test/app/initRepo.test.ts`
Expected: FAIL, cannot resolve `../../src/app/initRepo.js`.

- [ ] **Step 3: Write the hook installer**

`src/collectors/claudeCodeHooks.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"] as const;
const HOOK_COMMAND = "rpt hook";

type HookEntry = { type: "command"; command: string };
type HookMatcher = { matcher?: string; hooks: HookEntry[] };
type Settings = { hooks?: Record<string, HookMatcher[]> } & Record<string, unknown>;

export async function installHooks(repoRoot: string): Promise<void> {
	const path = join(repoRoot, ".claude", "settings.json");
	await mkdir(join(repoRoot, ".claude"), { recursive: true });
	const settings = await readSettings(path);
	const hooks = { ...(settings.hooks ?? {}) };
	for (const event of HOOK_EVENTS) hooks[event] = withRpt(hooks[event] ?? []);
	await writeFile(path, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`, "utf8");
}

export async function uninstallHooks(repoRoot: string): Promise<void> {
	const path = join(repoRoot, ".claude", "settings.json");
	const settings = await readSettings(path);
	if (settings.hooks === undefined) return;
	const hooks = Object.fromEntries(
		Object.entries(settings.hooks).map(([event, matchers]) => [event, withoutRpt(matchers)]),
	);
	await writeFile(path, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`, "utf8");
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
	try {
		return JSON.parse(await readFile(path, "utf8")) as Settings;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`.claude/settings.json is unreadable, refusing to overwrite it: ${(error as Error).message}`);
	}
}
```

Reading fails loudly on malformed JSON. Overwriting a settings file rpt could not parse would destroy user configuration.

- [ ] **Step 4: Write initRepo**

`src/app/initRepo.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installHooks } from "../collectors/claudeCodeHooks.js";
import { DEFAULT_CONFIG } from "../config/load.js";
import { rptDirOf } from "../store/paths.js";

export type InitReport = {
	hooksInstalled: boolean;
	gitignoreUpdated: boolean;
	configCreated: boolean;
	pricingCreated: boolean;
};

export async function initRepo(repoRoot: string): Promise<InitReport> {
	await mkdir(rptDirOf(repoRoot), { recursive: true });
	await installHooks(repoRoot);
	return {
		hooksInstalled: true,
		gitignoreUpdated: await ensureIgnored(repoRoot),
		configCreated: await createIfAbsent(join(repoRoot, "rpt.config.json"), configTemplate()),
		pricingCreated: await createIfAbsent(join(rptDirOf(repoRoot), "pricing.json"), pricingTemplate()),
	};
}

function configTemplate(): string {
	return `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
}

function pricingTemplate(): string {
	return `${JSON.stringify({ version: 1, rates: {} }, null, 2)}\n`;
}

async function ensureIgnored(repoRoot: string): Promise<boolean> {
	const path = join(repoRoot, ".gitignore");
	const current = await readOrEmpty(path);
	if (current.split("\n").includes(".rpt/")) return false;
	const separator = current === "" || current.endsWith("\n") ? "" : "\n";
	await writeFile(path, `${current}${separator}.rpt/\n`, "utf8");
	return true;
}

async function createIfAbsent(path: string, body: string): Promise<boolean> {
	try {
		await writeFile(path, body, { flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

async function readOrEmpty(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}
```

`rpt init` installs no git hooks in this plan. The pre-commit gate arrives in Plan 2 and extends `initRepo` there.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run test/app/initRepo.test.ts`
Expected: PASS, six tests.

- [ ] **Step 6: Delete the Task 8 stubs**

Remove the temporary `installHooks` and `uninstallHooks` stubs and confirm `src/collectors/claudeCode.ts` imports the real ones.

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/initRepo.ts src/collectors/claudeCodeHooks.ts test/app/initRepo.test.ts
git commit -m "feat: rpt init installs hooks, gitignore, config and pricing scaffolds"
```

---

### Task 12: Read-only CLI commands

**Files:**
- Create: `src/cli/format.ts`
- Create: `src/cli/render.ts`
- Create: `src/cli/index.ts`
- Test: `test/cli/render.test.ts`

**Interfaces:**
- Consumes: `AgentRun`, `listRuns`, `loadRun`, `readEvents`
- Produces: `OutputFormat = "text" | "json" | "agent"`; `renderRun(run: AgentRun, format: OutputFormat): string`; `renderRunList(entries: RunIndexEntry[], format: OutputFormat): string`; `renderTimeline(events: AgentEvent[], format: OutputFormat): string`

- [ ] **Step 1: Write the failing render test**

`test/cli/render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/domain/events.js";
import type { AgentRun } from "../../src/domain/run.js";
import { renderRun, renderTimeline } from "../../src/cli/render.js";

const run: AgentRun = {
	id: 1842,
	task: "fix authentication timeout",
	state: "ENDED",
	baseSha: "a".repeat(40),
	endSha: "b".repeat(40),
	startedAt: "2026-09-09T10:00:00.000Z",
	endedAt: "2026-09-09T10:08:41.000Z",
	hasGaps: false,
	claims: { mutatedPaths: ["src/auth/pool.ts"], commands: ["pnpm test"] },
	usage: [{ model: "claude-opus-5", input: 2, output: 410, cacheRead: 100, cacheCreate: 200 }],
};

describe("renderRun", () => {
	it("shows the run id, task and state in text form", () => {
		const output = renderRun(run, "text");
		expect(output).toContain("1842");
		expect(output).toContain("fix authentication timeout");
		expect(output).toContain("ENDED");
	});

	it("shows the duration in minutes and seconds", () => {
		expect(renderRun(run, "text")).toContain("08m 41s");
	});

	it("emits parseable json", () => {
		expect(JSON.parse(renderRun(run, "json")).id).toBe(1842);
	});

	it("keeps the agent format compact", () => {
		expect(renderRun(run, "agent").length).toBeLessThan(400);
	});

	it("warns visibly when the log has gaps", () => {
		expect(renderRun({ ...run, hasGaps: true }, "text")).toMatch(/gap/i);
	});
});

describe("renderTimeline", () => {
	it("prints one line per event with a relative offset", () => {
		const events: AgentEvent[] = [
			{ runId: 1, seq: 0, ts: "2026-09-09T10:00:00.000Z", source: "rpt", kind: "RunStarted", payload: {} },
			{ runId: 1, seq: 1, ts: "2026-09-09T10:00:42.000Z", source: "claude-code", kind: "FileMutated", payload: { path: "a.ts" } },
		];
		const lines = renderTimeline(events, "text").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("00:42");
		expect(lines[1]).toContain("a.ts");
	});
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run test/cli/render.test.ts`
Expected: FAIL, cannot resolve `../../src/cli/render.js`.

- [ ] **Step 3: Write the duration formatter**

`src/cli/format.ts`:

```ts
export type OutputFormat = "text" | "json" | "agent";

export function formatDuration(fromIso: string, toIso: string | null): string {
	if (toIso === null) return "running";
	const seconds = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
	return `${pad(Math.floor(seconds / 60))}m ${pad(seconds % 60)}s`;
}

export function formatOffset(startIso: string, atIso: string): string {
	const seconds = Math.max(0, Math.round((Date.parse(atIso) - Date.parse(startIso)) / 1000));
	return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}
```

- [ ] **Step 4: Write the renderers**

`src/cli/render.ts`:

```ts
import type { AgentEvent } from "../domain/events.js";
import type { AgentRun } from "../domain/run.js";
import type { RunIndexEntry } from "../store/runIndex.js";
import { formatDuration, formatOffset, type OutputFormat } from "./format.js";

export function renderRun(run: AgentRun, format: OutputFormat): string {
	if (format === "json") return JSON.stringify(run, null, 2);
	if (format === "agent") return agentLines(run).join("\n");
	return textLines(run).join("\n");
}

export function renderRunList(entries: RunIndexEntry[], format: OutputFormat): string {
	if (format === "json") return JSON.stringify(entries, null, 2);
	return entries
		.map((entry) => `${String(entry.id).padStart(5)}  ${entry.state.padEnd(18)}  ${entry.task}`)
		.join("\n");
}

export function renderTimeline(events: AgentEvent[], format: OutputFormat): string {
	if (format === "json") return JSON.stringify(events, null, 2);
	const start = events[0]?.ts ?? new Date().toISOString();
	return `${events.map((event) => timelineLine(start, event)).join("\n")}\n`;
}

function textLines(run: AgentRun): string[] {
	return [
		`RUN ${run.id}  ${run.state}`,
		"",
		`  ${run.task}`,
		"",
		`  duration   ${formatDuration(run.startedAt, run.endedAt)}`,
		`  files      ${run.claims.mutatedPaths.length} claimed`,
		`  commands   ${run.claims.commands.length}`,
		`  messages   ${run.usage.length}`,
		...(run.hasGaps ? ["", "  WARNING: event log has gaps, this run cannot be verified"] : []),
	];
}

function agentLines(run: AgentRun): string[] {
	return [
		`RUN ${run.id} ${run.state} | ${run.task}`,
		`files ${run.claims.mutatedPaths.length} | cmds ${run.claims.commands.length} | ${formatDuration(run.startedAt, run.endedAt)}`,
		...(run.hasGaps ? ["gaps present, not verifiable"] : []),
	];
}

function timelineLine(start: string, event: AgentEvent): string {
	return `${formatOffset(start, event.ts)}  ${event.kind.padEnd(20)} ${summarize(event)}`;
}

function summarize(event: AgentEvent): string {
	const payload = event.payload;
	const interesting = payload.path ?? payload.command ?? payload.tool ?? payload.model ?? "";
	return String(interesting);
}
```

- [ ] **Step 5: Write the CLI entry point**

`src/cli/index.ts`:

```ts
#!/usr/bin/env node
import { Command } from "commander";
import { loadRun } from "../app/loadRun.js";
import { initRepo } from "../app/initRepo.js";
import { readEvents } from "../store/eventLog.js";
import { rptDirOf } from "../store/paths.js";
import { activeRun, listRuns } from "../store/runIndex.js";
import { runHookCommand } from "./hook.js";
import type { OutputFormat } from "./format.js";
import { renderRun, renderRunList, renderTimeline } from "./render.js";

const program = new Command();
program.name("rpt").description("AI agent flight recorder and verification engine");
program.option("--format <format>", "text, json or agent", "text");

program.command("init").description("install hooks and scaffolds").action(async () => {
	const report = await initRepo(process.cwd());
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
});

program.command("hook").description("internal: consume an agent hook payload").action(async () => {
	process.exitCode = await runHookCommand(process.cwd(), await readStdin());
});

program.command("status").description("show the active run").action(async () => {
	const entry = await activeRun(rptDirOf(process.cwd()));
	if (entry === null) {
		process.stdout.write("no active run\n");
		return;
	}
	process.stdout.write(`${renderRun(await loadRun(process.cwd(), entry.id), formatOf())}\n`);
});

program.command("runs").description("list runs").action(async () => {
	process.stdout.write(`${renderRunList(await listRuns(rptDirOf(process.cwd())), formatOf())}\n`);
});

program.command("run <id>").description("show one run").action(async (id: string) => {
	process.stdout.write(`${renderRun(await loadRun(process.cwd(), Number(id)), formatOf())}\n`);
});

program
	.command("events <id>")
	.alias("replay")
	.description("print the event timeline")
	.action(async (id: string) => {
		const { events } = await readEvents(rptDirOf(process.cwd()), Number(id));
		process.stdout.write(renderTimeline(events, formatOf()));
	});

function formatOf(): OutputFormat {
	return program.opts<{ format: OutputFormat }>().format;
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

await program.parseAsync(process.argv);
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm vitest run test/cli/render.test.ts`
Expected: PASS, six tests.

- [ ] **Step 7: Verify the binary end to end by hand**

```bash
pnpm build
node dist/cli/index.js --help
```

Expected: the command list including `init`, `status`, `runs`, `run`, `events`.

- [ ] **Step 8: Commit**

```bash
git add src/cli test/cli
git commit -m "feat: read-only cli commands with text, json and agent formats"
```

---

### Task 13: Transcript enrichment and cost

**Files:**
- Create: `src/collectors/transcript.ts`
- Create: `src/pricing/table.ts`
- Create: `src/pricing/cost.ts`
- Test: `test/collectors/transcript.test.ts`
- Test: `test/pricing/cost.test.ts`
- Create: `test/fixtures/transcript.jsonl`

**Interfaces:**
- Consumes: `DraftEvent`, `ModelUsage`
- Produces: `readTranscriptUsage(path: string): Promise<DraftEvent[]>`; `PricingTable = { version: number; rates: Record<string, Rates> }`; `Rates = { input: number | null; output: number | null; cacheRead: number | null; cacheCreate: number | null }`; `loadPricing(rptDir: string): Promise<PricingTable>`; `costOf(usage: ModelUsage[], table: PricingTable): { usd: number | null; unpriced: string[] }`

- [ ] **Step 1: Build the transcript fixture from a real session**

```bash
f=$(ls -t ~/.claude/projects/*/*.jsonl | head -1)
python3 - "$f" <<'EOF' > test/fixtures/transcript.jsonl
import json, sys
kept = 0
for line in open(sys.argv[1]):
    try:
        record = json.loads(line)
    except ValueError:
        continue
    if record.get("type") != "assistant":
        continue
    message = record.get("message", {})
    print(json.dumps({
        "type": "assistant",
        "timestamp": record.get("timestamp"),
        "message": {"model": message.get("model"), "usage": message.get("usage")},
    }))
    kept += 1
    if kept == 3:
        break
EOF
wc -l test/fixtures/transcript.jsonl
```

Expected: three lines. Confirm each has a `model` and a `usage` object with `input_tokens`, `output_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`.

- [ ] **Step 2: Write the failing transcript test**

`test/collectors/transcript.test.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { readTranscriptUsage } from "../../src/collectors/transcript.js";

describe("readTranscriptUsage", () => {
	it("emits one ModelUsageRecorded per assistant message", async () => {
		const events = await readTranscriptUsage("test/fixtures/transcript.jsonl");
		expect(events).toHaveLength(3);
		expect(events.every((event) => event.kind === "ModelUsageRecorded")).toBe(true);
	});

	it("carries the model and all four token counts", async () => {
		const [event] = await readTranscriptUsage("test/fixtures/transcript.jsonl");
		expect(typeof event?.payload.model).toBe("string");
		expect(typeof event?.payload.input).toBe("number");
		expect(typeof event?.payload.output).toBe("number");
		expect(typeof event?.payload.cacheRead).toBe("number");
		expect(typeof event?.payload.cacheCreate).toBe("number");
	});

	it("skips malformed lines rather than failing the whole read", async () => {
		const dir = await mkdtemp(join(tmpdir(), "rpt-transcript-"));
		const path = join(dir, "t.jsonl");
		await writeFile(path, 'not json\n{"type":"assistant","message":{"model":"m","usage":{"output_tokens":1}}}\n');
		expect(await readTranscriptUsage(path)).toHaveLength(1);
	});

	it("returns nothing for a missing transcript instead of throwing", async () => {
		expect(await readTranscriptUsage("/nonexistent/transcript.jsonl")).toEqual([]);
	});
});
```

- [ ] **Step 3: Write the failing cost test**

`test/pricing/cost.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ModelUsage } from "../../src/domain/run.js";
import { costOf, type PricingTable } from "../../src/pricing/cost.js";

const usage: ModelUsage[] = [
	{ model: "model-a", input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreate: 0 },
];

const table: PricingTable = {
	version: 1,
	rates: { "model-a": { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 } },
};

describe("costOf", () => {
	it("prices a million input and a million output tokens at their rates", () => {
		expect(costOf(usage, table)).toEqual({ usd: 18, unpriced: [] });
	});

	it("sums across messages", () => {
		expect(costOf([...usage, ...usage], table).usd).toBe(36);
	});

	it("returns null and names the model when a rate is missing", () => {
		const result = costOf([{ ...usage[0]!, model: "model-b" }], table);
		expect(result).toEqual({ usd: null, unpriced: ["model-b"] });
	});

	it("returns null when a rate is explicitly null rather than guessing", () => {
		const partial: PricingTable = {
			version: 1,
			rates: { "model-a": { input: null, output: 15, cacheRead: 0.3, cacheCreate: 3.75 } },
		};
		expect(costOf(usage, partial).usd).toBeNull();
	});

	it("is zero for a run with no usage at all", () => {
		expect(costOf([], table)).toEqual({ usd: 0, unpriced: [] });
	});
});
```

- [ ] **Step 4: Run both tests and confirm they fail**

Run: `pnpm vitest run test/collectors/transcript.test.ts test/pricing/cost.test.ts`
Expected: FAIL, modules unresolved.

- [ ] **Step 5: Write the transcript reader**

`src/collectors/transcript.ts`:

```ts
import { readFile } from "node:fs/promises";
import type { DraftEvent } from "../domain/events.js";

type TranscriptUsage = {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
};

type TranscriptRecord = {
	type?: string;
	timestamp?: string;
	message?: { model?: string; usage?: TranscriptUsage };
};

export async function readTranscriptUsage(path: string): Promise<DraftEvent[]> {
	const text = await readOrEmpty(path);
	return text
		.split("\n")
		.filter((line) => line !== "")
		.flatMap((line) => usageEvent(line));
}

function usageEvent(line: string): DraftEvent[] {
	const record = parse(line);
	if (record?.type !== "assistant" || record.message?.usage === undefined) return [];
	const usage = record.message.usage;
	return [
		{
			ts: record.timestamp ?? new Date().toISOString(),
			source: "claude-code",
			kind: "ModelUsageRecorded",
			payload: {
				model: record.message.model ?? "unknown",
				input: usage.input_tokens ?? 0,
				output: usage.output_tokens ?? 0,
				cacheRead: usage.cache_read_input_tokens ?? 0,
				cacheCreate: usage.cache_creation_input_tokens ?? 0,
			},
		},
	];
}

function parse(line: string): TranscriptRecord | null {
	try {
		return JSON.parse(line) as TranscriptRecord;
	} catch {
		return null;
	}
}

async function readOrEmpty(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}
```

A missing transcript returns nothing rather than throwing, because a transcript can legitimately be absent. Any other read error still throws.

- [ ] **Step 6: Write pricing**

`src/pricing/cost.ts`:

```ts
import type { ModelUsage } from "../domain/run.js";

export type Rates = {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheCreate: number | null;
};

export type PricingTable = { version: number; rates: Record<string, Rates> };

export type Cost = { usd: number | null; unpriced: string[] };

const PER_MILLION = 1_000_000;

export function costOf(usage: readonly ModelUsage[], table: PricingTable): Cost {
	const unpriced = [...new Set(usage.filter((entry) => !isPriced(entry, table)).map((entry) => entry.model))];
	if (unpriced.length > 0) return { usd: null, unpriced };
	const usd = usage.reduce((total, entry) => total + priceOne(entry, table.rates[entry.model]!), 0);
	return { usd: round(usd), unpriced: [] };
}

function isPriced(entry: ModelUsage, table: PricingTable): boolean {
	const rates = table.rates[entry.model];
	if (rates === undefined) return false;
	return Object.values(rates).every((rate) => rate !== null);
}

function priceOne(entry: ModelUsage, rates: Rates): number {
	return (
		(entry.input * (rates.input ?? 0) +
			entry.output * (rates.output ?? 0) +
			entry.cacheRead * (rates.cacheRead ?? 0) +
			entry.cacheCreate * (rates.cacheCreate ?? 0)) /
		PER_MILLION
	);
}

function round(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}
```

`src/pricing/table.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PricingTable } from "./cost.js";

export const EMPTY_PRICING: PricingTable = { version: 1, rates: {} };

export async function loadPricing(rptDir: string): Promise<PricingTable> {
	try {
		return JSON.parse(await readFile(join(rptDir, "pricing.json"), "utf8")) as PricingTable;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_PRICING;
		throw new Error(`.rpt/pricing.json is unreadable: ${(error as Error).message}`);
	}
}
```

rpt ships no rates. An unpriced model produces a null cost and is named in the output, which is the honest answer when the price is unknown.

- [ ] **Step 7: Wire enrichment into endRun**

In `src/app/endRun.ts`, after the `AgentStopped` append and before reloading the run, append the transcript usage events. Read the transcript path from the run's `RunStarted` payload.

```ts
const started = (await readEvents(rptDir, runId)).events.find((event) => event.kind === "RunStarted");
const transcriptPath = typeof started?.payload.transcriptPath === "string" ? started.payload.transcriptPath : null;
for (const draft of await claudeCodeAdapter.enrich(await loadRun(repoRoot, runId), { transcriptPath })) {
	await appendEvent(rptDir, runId, draft);
}
```

Add a test to `test/app/lifecycle.test.ts` asserting that a run started with a fixture transcript path ends with a non-empty `usage` array.

- [ ] **Step 8: Run the full suite and confirm it passes**

Run: `pnpm test`
Expected: PASS, every suite.

- [ ] **Step 9: Commit**

```bash
git add src/collectors/transcript.ts src/pricing src/app/endRun.ts test/collectors test/pricing test/fixtures
git commit -m "feat: transcript enrichment and pricing with no invented rates"
```

---

### Task 14: End-to-end recorded run

**Files:**
- Create: `test/e2e/recordedRun.test.ts`
- Create: `test/support/fakeAgent.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: everything
- Produces: `driveFakeAgent(repo: string, script: FakeStep[]): Promise<void>`

- [ ] **Step 1: Write the fake agent driver**

`test/support/fakeAgent.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { handleHook } from "../../src/cli/hook.js";

export type FakeStep =
	| { kind: "start"; transcriptPath: string | null }
	| { kind: "edit"; path: string; body: string }
	| { kind: "bash"; command: string }
	| { kind: "stop" };

export async function driveFakeAgent(repo: string, script: FakeStep[]): Promise<void> {
	for (const step of script) await runStep(repo, step);
}

async function runStep(repo: string, step: FakeStep): Promise<void> {
	if (step.kind === "start") {
		await handleHook(repo, {
			hook_event_name: "SessionStart",
			cwd: repo,
			transcript_path: step.transcriptPath,
		});
		return;
	}
	if (step.kind === "edit") {
		await writeFile(join(repo, step.path), step.body);
		await handleHook(repo, {
			hook_event_name: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: step.path },
			tool_response: { success: true },
		});
		return;
	}
	if (step.kind === "bash") {
		await handleHook(repo, {
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: step.command },
			tool_response: { exit_code: 0 },
		});
		return;
	}
	await handleHook(repo, { hook_event_name: "Stop" });
}
```

If the captured fixtures from Task 8 use different field names, change these payloads to match them exactly. The fake agent is only useful if it speaks the real wire format.

- [ ] **Step 2: Write the failing end-to-end test**

`test/e2e/recordedRun.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadRun } from "../../src/app/loadRun.js";
import { initRepo } from "../../src/app/initRepo.js";
import { diffNameStatus } from "../../src/git/diff.js";
import { rptDirOf } from "../../src/store/paths.js";
import { activeRun } from "../../src/store/runIndex.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

async function recordedRun(): Promise<{ repo: string }> {
	const repo = await makeFixtureRepo();
	await initRepo(repo);
	await driveFakeAgent(repo, [
		{ kind: "start", transcriptPath: "test/fixtures/transcript.jsonl" },
		{ kind: "edit", path: "auth.ts", body: "export const timeout = 5000;\n" },
		{ kind: "bash", command: "pnpm test" },
		{ kind: "stop" },
	]);
	return { repo };
}

describe("a full recorded run", () => {
	it("ends in ENDED and becomes the active run", async () => {
		const { repo } = await recordedRun();
		const run = await loadRun(repo, 1);
		expect(run.state).toBe("ENDED");
		expect((await activeRun(rptDirOf(repo)))?.id).toBe(1);
	});

	it("records the agent's claim about the edited file", async () => {
		const { repo } = await recordedRun();
		expect((await loadRun(repo, 1)).claims.mutatedPaths).toEqual(["auth.ts"]);
	});

	it("observes the same file independently in the git diff", async () => {
		const { repo } = await recordedRun();
		const run = await loadRun(repo, 1);
		const observed = await diffNameStatus(repo, run.baseSha!, run.endSha!);
		expect(observed).toEqual([{ path: "auth.ts", status: "A" }]);
	});

	it("has no gaps", async () => {
		const { repo } = await recordedRun();
		expect((await loadRun(repo, 1)).hasGaps).toBe(false);
	});

	it("carries model usage from the transcript", async () => {
		const { repo } = await recordedRun();
		expect((await loadRun(repo, 1)).usage.length).toBeGreaterThan(0);
	});

	it("never touches the user's staging area", async () => {
		const { repo } = await recordedRun();
		const { git } = await import("../../src/git/exec.js");
		expect(await git(repo, ["diff", "--cached", "--name-only"])).toBe("");
	});
});
```

- [ ] **Step 3: Run the test and confirm it fails, then passes**

Run: `pnpm vitest run test/e2e/recordedRun.test.ts`
Expected: FAIL first on the missing `test/support/fakeAgent.ts`, then PASS once Step 1 is in place. Any other failure is a real defect in an earlier task. Fix the defect, not the test.

- [ ] **Step 4: Check coverage against the floor**

Run: `pnpm test:cov`
Expected: all four thresholds at or above 80. If a module falls short, add tests for its untested branches rather than lowering the threshold.

- [ ] **Step 5: Write the README**

`README.md` covering: what rpt is in three sentences, install, `rpt init`, what gets recorded, `rpt status`, `rpt runs`, `rpt events`, where data lives, and an explicit statement that Plan 1 records and replays but does not yet verify, score or gate.

- [ ] **Step 6: Review the whole plan's output**

Dispatch the `swe:swe` agent over `git diff main...HEAD` for the full range of Plan 1. Fix every violation it reports before closing the plan.

- [ ] **Step 7: Commit**

```bash
git add test/e2e test/support/fakeAgent.ts README.md
git commit -m "test: end-to-end recorded run with independent git observation"
```

---

## Plan 1 self-review

**Spec coverage.** Section 5 layering is Tasks 1 to 13 with the purity guard in Task 4. Section 6 events are Task 2. Section 7 lifecycle is Task 3, with adjudication states unreachable until Plan 2, which is correct because nothing can verify yet. Section 8 boundaries and snapshotting are Task 7 and Task 10. Section 9 claimed versus observed is established in Task 4 and asserted end to end in Task 14. Section 14 cost accounting is Task 13. Section 15 storage is Tasks 5 and 6. Section 16 configuration is Task 1. Section 17 surfaces are partially covered: the read-only text, json and agent formats ship in Task 12, while the Ink surface and slash plugin are Plan 3. Section 18 adapter seam is Task 8. Section 19 error handling is Task 9 and Task 10. Section 20 testing is distributed across every task.

**Not in this plan, by design.** Sections 10, 11, 12 and 13, meaning verifiers, risk, gate, approval and attestation, are Plan 2. `rpt doctor` is Plan 3.

**Type consistency.** `DraftEvent` has no `runId` or `seq`; only `appendEvent` adds them. `AgentEvent` is used everywhere downstream. `ReadResult` is `{ events, gapCount }` in both Task 5 and Task 10. `RunIndexEntry` fields match between Task 6, Task 10 and Task 12. `ModelUsage` is defined once in Task 4 and consumed unchanged in Task 13. `OutputFormat` is defined in `src/cli/format.ts` and imported by `render.ts` and `index.ts`.

**Known forward references.** Task 8 imports `installHooks` and `readTranscriptUsage` before Tasks 11 and 13 write them. The stub-then-delete instruction is explicit in both places.
