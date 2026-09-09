# rpt Console and Agent Surface Implementation Plan (Plan 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give rpt its two surfaces. A terminal console built with Ink for people, and a read-only slash command plugin for agents, both driven by the same engine.

**Architecture:** The Ink layer is a pure presentation shell over a read model. `src/app/readModel.ts` returns plain serialisable data; no component imports `store/`, `git/`, `verifiers/` or `risk/` directly. That constraint is what makes the Ink layer disposable: swapping it for a web UI touches `src/ui/` and nothing else. The agent surface is the existing `--format=agent` output, wrapped in Claude Code slash commands that expose read-only verbs only.

**Tech Stack:** Ink 5 with React 18, ink-testing-library. No other new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-09-rpt-design.md`

**Depends on:** Plan 1 and Plan 2, both complete with passing tests.

## Global Constraints

- All Plan 1 and Plan 2 constraints continue to apply.
- `src/ui/` imports from `src/app/` and nothing else, apart from type-only imports. Enforced by a test in Task 1.
- No component performs I/O. Data arrives as props from the read model.
- The slash plugin exposes read-only verbs. `approve` and `reject` are never reachable from an agent surface, and a test asserts the plugin ships no command that names them.
- Every screen must render correctly with no runs, one run, and a run whose log has gaps.
- The console is read-mostly. The only mutating action it offers is approval, and that path goes through the same `assertHuman` check as the CLI rather than a parallel one.

---

### Task 1: Read model and the UI boundary

**Files:**
- Modify: `package.json`
- Create: `src/app/readModel.ts`
- Test: `test/app/readModel.test.ts`
- Test: `test/ui/boundary.test.ts`

**Interfaces:**
- Consumes: `listRuns`, `loadRun`, `readVerdict`, `readApproval`, `readEvents`, `assessRisk`, `buildFacts`, `costOf`, `loadPricing`
- Produces: `RunSummary = { id, task, state, startedAt, endedAt, riskScore, riskLevel, costUsd }`; `DashboardModel = { runs: RunSummary[] }`; `RunDetailModel = { run, verdict, risk, approval, events, costUsd, unpricedModels }`; `dashboardModel(repoRoot): Promise<DashboardModel>`; `runDetailModel(repoRoot, runId): Promise<RunDetailModel>`

- [ ] **Step 1: Add the Ink dependencies**

```bash
pnpm add ink react
pnpm add -D ink-testing-library @types/react
```

Record the resolved versions in `package.json`. Ink requires React as a peer; confirm both resolved before continuing.

- [ ] **Step 2: Write the failing read model test**

`test/app/readModel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { initRepo } from "../../src/app/initRepo.js";
import { dashboardModel, runDetailModel } from "../../src/app/readModel.js";
import { verifyRun } from "../../src/app/verifyRun.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

async function repoWithVerifiedRun(): Promise<string> {
	const repo = await makeFixtureRepo();
	await initRepo(repo);
	await driveFakeAgent(repo, [
		{ kind: "start", transcriptPath: null },
		{ kind: "edit", path: "a.ts", body: "export const a = 1;\n" },
		{ kind: "stop" },
	]);
	await verifyRun(repo, 1);
	return repo;
}

describe("dashboardModel", () => {
	it("is empty for a repo with no runs", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		expect((await dashboardModel(repo)).runs).toEqual([]);
	});

	it("summarises each run with its risk band", async () => {
		const model = await dashboardModel(await repoWithVerifiedRun());
		expect(model.runs).toHaveLength(1);
		expect(model.runs[0]?.riskLevel).toMatch(/LOW|MEDIUM|HIGH|CRITICAL/);
	});

	it("reports a null risk for a run that has not been verified", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		await driveFakeAgent(repo, [{ kind: "start", transcriptPath: null }, { kind: "stop" }]);
		expect((await dashboardModel(repo)).runs[0]?.riskScore).toBeNull();
	});

	it("returns plain serialisable data", async () => {
		const model = await dashboardModel(await repoWithVerifiedRun());
		expect(() => structuredClone(model)).not.toThrow();
	});
});

describe("runDetailModel", () => {
	it("carries the run, its verdict, its risk and its events", async () => {
		const model = await runDetailModel(await repoWithVerifiedRun(), 1);
		expect(model.run.id).toBe(1);
		expect(model.verdict?.name).toBeDefined();
		expect(model.risk?.contributions.length).toBeGreaterThan(0);
		expect(model.events.length).toBeGreaterThan(0);
	});

	it("names unpriced models rather than reporting a wrong cost", async () => {
		const model = await runDetailModel(await repoWithVerifiedRun(), 1);
		expect(model.costUsd === null || typeof model.costUsd === "number").toBe(true);
	});

	it("has a null approval until a human decides", async () => {
		expect((await runDetailModel(await repoWithVerifiedRun(), 1)).approval).toBeNull();
	});
});
```

- [ ] **Step 3: Write the read model**

`src/app/readModel.ts` composes the existing use cases and returns plain objects. Every field is a primitive, an array, or a plain object, so the model can be serialised, snapshot-tested, and later shipped to a web UI unchanged.

```ts
import { loadConfig } from "../config/load.js";
import type { AgentEvent, RunId } from "../domain/events.js";
import type { AgentRun } from "../domain/run.js";
import type { Verdict } from "../domain/verdict.js";
import { costOf } from "../pricing/cost.js";
import { loadPricing } from "../pricing/table.js";
import { assessRisk, type RiskAssessment, type RiskLevel } from "../risk/assess.js";
import { buildFacts } from "../risk/facts.js";
import { readEvents } from "../store/eventLog.js";
import { rptDirOf } from "../store/paths.js";
import { listRuns } from "../store/runIndex.js";
import { readApproval, type Approval } from "./approveRun.js";
import { loadRun } from "./loadRun.js";
import { readVerdict } from "./verifyRun.js";

export type RunSummary = {
	id: RunId;
	task: string;
	state: string;
	startedAt: string;
	endedAt: string | null;
	riskScore: number | null;
	riskLevel: RiskLevel | null;
	costUsd: number | null;
};

export type DashboardModel = { runs: RunSummary[] };

export type RunDetailModel = {
	run: AgentRun;
	verdict: Verdict | null;
	risk: RiskAssessment | null;
	approval: Approval | null;
	events: AgentEvent[];
	costUsd: number | null;
	unpricedModels: string[];
};

export async function dashboardModel(repoRoot: string): Promise<DashboardModel> {
	const entries = await listRuns(rptDirOf(repoRoot));
	return { runs: await Promise.all(entries.map((entry) => summarise(repoRoot, entry.id))) };
}

export async function runDetailModel(repoRoot: string, runId: RunId): Promise<RunDetailModel> {
	const run = await loadRun(repoRoot, runId);
	const verdict = await readVerdict(repoRoot, runId);
	const config = await loadConfig(repoRoot);
	const cost = costOf(run.usage, await loadPricing(rptDirOf(repoRoot)));
	return {
		run,
		verdict,
		risk: verdict === null ? null : assessRisk(buildFacts(verdict.results, config), config),
		approval: await readApproval(repoRoot, runId),
		events: (await readEvents(rptDirOf(repoRoot), runId)).events,
		costUsd: cost.usd,
		unpricedModels: cost.unpriced,
	};
}

async function summarise(repoRoot: string, runId: RunId): Promise<RunSummary> {
	const detail = await runDetailModel(repoRoot, runId);
	return {
		id: detail.run.id,
		task: detail.run.task,
		state: detail.run.state,
		startedAt: detail.run.startedAt,
		endedAt: detail.run.endedAt,
		riskScore: detail.risk?.score ?? null,
		riskLevel: detail.risk?.level ?? null,
		costUsd: detail.costUsd,
	};
}
```

- [ ] **Step 4: Write the UI boundary guard**

`test/ui/boundary.test.ts` walks `src/ui/` recursively and asserts that no file imports from `../store/`, `../git/`, `../verifiers/`, `../daemon/` or any `node:` module. Imports from `../app/`, from sibling `ui` files, and from `ink` and `react` are allowed, as is a type-only import from `../risk/assess.js` for `RiskLevel`. It passes vacuously until Task 2 adds files, and it is what keeps the layer disposable as the console grows.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run test/app/readModel.test.ts test/ui/boundary.test.ts`
Expected: PASS, eight tests.

- [ ] **Step 6: Commit**

```bash
git add package.json src/app/readModel.ts test/app/readModel.test.ts test/ui/boundary.test.ts
git commit -m "feat: serialisable read model and enforced ui boundary"
```

---

### Task 2: Presentation primitives

**Files:**
- Modify: `tsconfig.json`, `vitest.config.ts`
- Create: `src/ui/theme.ts`
- Create: `src/ui/components/Panel.tsx`
- Create: `src/ui/components/StatTiles.tsx`
- Create: `src/ui/components/Bar.tsx`
- Test: `test/ui/components.test.tsx`

**Interfaces:**
- Consumes: `RiskLevel`
- Produces: `colorForLevel(level: RiskLevel | null): string`; `colorForState(state: string): string`; `Panel({ title, children })`; `Tile = { label: string; value: string; color?: string }`; `StatTiles({ tiles })`; `Bar({ value, max, width })`

- [ ] **Step 1: Enable JSX**

Add `"jsx": "react-jsx"` to `tsconfig.json` compiler options. Add `esbuild: { jsx: "automatic" }` to `vitest.config.ts` and include `test/**/*.test.tsx` in the test glob.

- [ ] **Step 2: Write the failing component test**

`test/ui/components.test.tsx`:

```tsx
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { Bar } from "../../src/ui/components/Bar.js";
import { Panel } from "../../src/ui/components/Panel.js";
import { StatTiles } from "../../src/ui/components/StatTiles.js";
import { colorForLevel } from "../../src/ui/theme.js";

describe("Panel", () => {
	it("renders its title", () => {
		const { lastFrame } = render(
			<Panel title="RISK">
				<></>
			</Panel>,
		);
		expect(lastFrame()).toContain("RISK");
	});
});

describe("StatTiles", () => {
	it("renders a label and value for each tile", () => {
		const { lastFrame } = render(
			<StatTiles tiles={[{ label: "Duration", value: "08m 41s" }, { label: "Files", value: "7" }]} />,
		);
		expect(lastFrame()).toContain("Duration");
		expect(lastFrame()).toContain("08m 41s");
		expect(lastFrame()).toContain("Files");
	});

	it("stays mounted with an empty tile list", () => {
		expect(render(<StatTiles tiles={[]} />).lastFrame()).toBeDefined();
	});
});

describe("Bar", () => {
	it("fills proportionally", () => {
		expect(render(<Bar value={50} max={100} width={10} />).lastFrame()?.match(/#/g)).toHaveLength(5);
	});

	it("clamps a value above the maximum", () => {
		expect(render(<Bar value={999} max={100} width={10} />).lastFrame()?.match(/#/g)).toHaveLength(10);
	});

	it("renders an empty bar at zero", () => {
		expect(render(<Bar value={0} max={100} width={10} />).lastFrame()?.match(/#/g)).toBeNull();
	});
});

describe("colorForLevel", () => {
	it("gives every band a distinct colour", () => {
		const colors = new Set([
			colorForLevel("LOW"),
			colorForLevel("MEDIUM"),
			colorForLevel("HIGH"),
			colorForLevel("CRITICAL"),
		]);
		expect(colors.size).toBe(4);
	});

	it("has a colour for an unassessed run", () => {
		expect(typeof colorForLevel(null)).toBe("string");
	});
});
```

The bar characters in these assertions are placeholders. Use whatever glyphs `Bar` actually renders, and keep the test and the component in agreement.

- [ ] **Step 3: Write the primitives**

`src/ui/theme.ts`:

```ts
import type { RiskLevel } from "../risk/assess.js";

export function colorForLevel(level: RiskLevel | null): string {
	if (level === "CRITICAL") return "red";
	if (level === "HIGH") return "yellow";
	if (level === "MEDIUM") return "cyan";
	return level === "LOW" ? "green" : "gray";
}

export function colorForState(state: string): string {
	if (state === "VERIFIED" || state === "APPROVED" || state === "RECORDED") return "green";
	if (state === "FAILED" || state === "REJECTED") return "red";
	if (state === "UNVERIFIED" || state === "AWAITING_APPROVAL") return "yellow";
	return "cyan";
}
```

`src/ui/components/Bar.tsx`:

```tsx
import { Text } from "ink";
import React from "react";

const FILLED = "█";
const EMPTY = "░";

export function Bar({ value, max, width }: { value: number; max: number; width: number }): React.ReactElement {
	const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
	return <Text>{`${FILLED.repeat(filled)}${EMPTY.repeat(width - filled)}`}</Text>;
}
```

`Panel` renders a bordered `Box` with the title in bold on its first line. `StatTiles` renders a row of bordered boxes, each with a dim label above a bright value.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run test/ui/components.test.tsx`
Expected: PASS, eight tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui tsconfig.json vitest.config.ts test/ui/components.test.tsx
git commit -m "feat: ink presentation primitives with risk and state colours"
```

---

### Task 3: Dashboard screen

**Files:**
- Create: `src/ui/screens/Dashboard.tsx`
- Test: `test/ui/Dashboard.test.tsx`

**Interfaces:**
- Consumes: `DashboardModel`
- Produces: `Dashboard({ model, selectedIndex })`

- [ ] **Step 1: Write the failing screen test**

`test/ui/Dashboard.test.tsx`:

```tsx
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import type { DashboardModel } from "../../src/app/readModel.js";
import { Dashboard } from "../../src/ui/screens/Dashboard.js";

const model: DashboardModel = {
	runs: [
		{
			id: 1842,
			task: "fix authentication timeout",
			state: "VERIFIED",
			startedAt: "2026-09-09T10:00:00.000Z",
			endedAt: "2026-09-09T10:08:41.000Z",
			riskScore: 47,
			riskLevel: "MEDIUM",
			costUsd: 1.84,
		},
		{
			id: 1841,
			task: "add pagination",
			state: "FAILED",
			startedAt: "2026-09-09T09:00:00.000Z",
			endedAt: "2026-09-09T09:02:00.000Z",
			riskScore: 12,
			riskLevel: "LOW",
			costUsd: null,
		},
	],
};

describe("Dashboard", () => {
	it("lists every run with id, task and state", () => {
		const frame = render(<Dashboard model={model} selectedIndex={0} />).lastFrame() ?? "";
		expect(frame).toContain("1842");
		expect(frame).toContain("fix authentication timeout");
		expect(frame).toContain("VERIFIED");
	});

	it("shows the risk band", () => {
		expect(render(<Dashboard model={model} selectedIndex={0} />).lastFrame()).toContain("MEDIUM");
	});

	it("shows unknown rather than a number when cost could not be priced", () => {
		expect(render(<Dashboard model={model} selectedIndex={0} />).lastFrame()).toContain("unknown");
	});

	it("marks the selected row", () => {
		const frame = render(<Dashboard model={model} selectedIndex={1} />).lastFrame() ?? "";
		const selected = frame.split("\n").find((line) => line.includes("1841")) ?? "";
		expect(selected.trimStart().startsWith(">")).toBe(true);
	});

	it("renders an explanatory empty state", () => {
		const frame = render(<Dashboard model={{ runs: [] }} selectedIndex={0} />).lastFrame() ?? "";
		expect(frame).toMatch(/no runs/i);
		expect(frame).toMatch(/rpt init/);
	});
});
```

- [ ] **Step 2: Write the screen**

`src/ui/screens/Dashboard.tsx` renders a header line with the tool name on the left and `Agent Verification Engine` on the right, then one row per run: selection marker, id, state coloured by `colorForState`, risk band coloured by `colorForLevel`, cost, task. The empty state names `rpt init` as the next step.

- [ ] **Step 3: Run the test and confirm it passes**

Run: `pnpm vitest run test/ui/Dashboard.test.tsx`
Expected: PASS, five tests.

- [ ] **Step 4: Commit**

```bash
git add src/ui/screens/Dashboard.tsx test/ui/Dashboard.test.tsx
git commit -m "feat: dashboard screen listing runs with risk and cost"
```

---

### Task 4: Run detail, events, diff and risk screens

**Files:**
- Create: `src/ui/screens/RunDetail.tsx`
- Create: `src/ui/screens/Events.tsx`
- Create: `src/ui/screens/Diff.tsx`
- Create: `src/ui/screens/Risk.tsx`
- Test: `test/ui/screens.test.tsx`

**Interfaces:**
- Consumes: `RunDetailModel`
- Produces: `RunDetail({ model })`, `Events({ model })`, `Diff({ patch })`, `Risk({ model })`

- [ ] **Step 1: Write the failing screens test**

`test/ui/screens.test.tsx`:

```tsx
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import type { RunDetailModel } from "../../src/app/readModel.js";
import { Diff } from "../../src/ui/screens/Diff.js";
import { Events } from "../../src/ui/screens/Events.js";
import { Risk } from "../../src/ui/screens/Risk.js";
import { RunDetail } from "../../src/ui/screens/RunDetail.js";

const model: RunDetailModel = {
	run: {
		id: 1842,
		task: "fix authentication timeout",
		state: "VERIFIED",
		baseSha: "a".repeat(40),
		endSha: "b".repeat(40),
		startedAt: "2026-09-09T10:00:00.000Z",
		endedAt: "2026-09-09T10:08:41.000Z",
		hasGaps: false,
		claims: { mutatedPaths: ["src/auth/pool.ts"], commands: ["pnpm test"] },
		usage: [],
	},
	verdict: {
		runId: 1842,
		name: "VERIFIED",
		results: [
			{ id: "tests", status: "passed", reason: null, facts: { passed: 184, failed: 0 } },
			{ id: "security", status: "skipped", reason: "offline", facts: {} },
		],
		decidedAt: "2026-09-09T10:09:00.000Z",
	},
	risk: {
		score: 47,
		level: "MEDIUM",
		contributions: [
			{ id: "sensitive-auth", label: "Authentication or authorization paths modified", points: 25 },
			{ id: "tests-added", label: "Regression tests added", points: -10 },
		],
	},
	approval: null,
	events: [
		{ runId: 1842, seq: 0, ts: "2026-09-09T10:00:00.000Z", source: "rpt", kind: "RunStarted", payload: {} },
		{
			runId: 1842,
			seq: 1,
			ts: "2026-09-09T10:00:42.000Z",
			source: "claude-code",
			kind: "FileMutated",
			payload: { path: "src/auth/pool.ts" },
		},
	],
	costUsd: 1.84,
	unpricedModels: [],
};

describe("RunDetail", () => {
	it("shows the task, duration, cost and risk together", () => {
		const frame = render(<RunDetail model={model} />).lastFrame() ?? "";
		expect(frame).toContain("fix authentication timeout");
		expect(frame).toContain("08m 41s");
		expect(frame).toContain("1.84");
		expect(frame).toContain("MEDIUM");
	});

	it("shows test counts observed by the verifier", () => {
		expect(render(<RunDetail model={model} />).lastFrame()).toContain("184");
	});

	it("shows a skipped verifier with its reason rather than as a pass", () => {
		const frame = render(<RunDetail model={model} />).lastFrame() ?? "";
		expect(frame).toContain("skipped");
		expect(frame).toContain("offline");
	});

	it("warns prominently when the log has gaps", () => {
		const gapped = { ...model, run: { ...model.run, hasGaps: true } };
		expect(render(<RunDetail model={gapped} />).lastFrame()).toMatch(/gap/i);
	});

	it("renders a run that has never been verified", () => {
		const bare = { ...model, verdict: null, risk: null };
		expect(render(<RunDetail model={bare} />).lastFrame()).toMatch(/not verified/i);
	});
});

describe("Events", () => {
	it("prints one row per event with a relative offset", () => {
		const frame = render(<Events model={model} />).lastFrame() ?? "";
		expect(frame).toContain("00:42");
		expect(frame).toContain("FileMutated");
	});
});

describe("Diff", () => {
	it("shows additions and removals", () => {
		const patch = ["+++ b/a.ts", "+added", "-removed"].join("\n");
		const frame = render(<Diff patch={patch} />).lastFrame() ?? "";
		expect(frame).toContain("+added");
		expect(frame).toContain("-removed");
	});

	it("renders an empty diff without crashing", () => {
		expect(render(<Diff patch="" />).lastFrame()).toBeDefined();
	});
});

describe("Risk", () => {
	it("shows the score and every contribution", () => {
		const frame = render(<Risk model={model} />).lastFrame() ?? "";
		expect(frame).toContain("47");
		expect(frame).toContain("+25");
		expect(frame).toContain("-10");
	});

	it("says approval is required at HIGH", () => {
		const high = { ...model, risk: { ...model.risk!, score: 67, level: "HIGH" as const } };
		expect(render(<Risk model={high} />).lastFrame()).toMatch(/approval required/i);
	});

	it("renders a placeholder when the run has no assessment", () => {
		expect(render(<Risk model={{ ...model, risk: null }} />).lastFrame()).toMatch(/not verified/i);
	});
});
```

- [ ] **Step 2: Write the four screens**

Each screen is a function component taking the model as its only prop and rendering with `Panel`, `StatTiles` and `Bar`. `Diff` truncates to the first 400 lines with a footer stating how many were hidden, so a large diff cannot lock the terminal.

- [ ] **Step 3: Run the test and confirm it passes**

Run: `pnpm vitest run test/ui/screens.test.tsx`
Expected: PASS, eleven tests.

- [ ] **Step 4: Commit**

```bash
git add src/ui/screens test/ui/screens.test.tsx
git commit -m "feat: run detail, events, diff and risk screens"
```

---

### Task 5: Application shell, navigation and approval

**Files:**
- Create: `src/ui/App.tsx`
- Create: `src/ui/screens/Approve.tsx`
- Modify: `src/cli/index.ts`
- Test: `test/ui/App.test.tsx`

**Interfaces:**
- Consumes: `dashboardModel`, `runDetailModel`, `approveRun`, `rejectRun`, `actorFromEnvironment`
- Produces: `App({ repoRoot })`; `renderConsole(repoRoot: string): Promise<void>`

- [ ] **Step 1: Write the failing shell test**

`test/ui/App.test.tsx`. Control keys are built with `String.fromCharCode` rather than embedded as literal control characters, so the file stays safe to copy, paste and diff.

```tsx
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { App } from "../../src/ui/App.js";
import { initRepo } from "../../src/app/initRepo.js";
import { verifyRun } from "../../src/app/verifyRun.js";
import { driveFakeAgent } from "../support/fakeAgent.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

const ESCAPE = String.fromCharCode(27);
const ENTER = String.fromCharCode(13);

async function repoWithRun(): Promise<string> {
	const repo = await makeFixtureRepo();
	await initRepo(repo);
	await driveFakeAgent(repo, [
		{ kind: "start", transcriptPath: null },
		{ kind: "edit", path: "a.ts", body: "export const a = 1;\n" },
		{ kind: "stop" },
	]);
	await verifyRun(repo, 1);
	return repo;
}

function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 50));
}

describe("App", () => {
	it("shows a loading state before the first model arrives", () => {
		expect(render(<App repoRoot="/nonexistent" />).lastFrame()).toMatch(/loading/i);
	});

	it("opens on the dashboard", async () => {
		const { lastFrame } = render(<App repoRoot={await repoWithRun()} />);
		await settle();
		expect(lastFrame()).toMatch(/RUNS|no runs/i);
	});

	it("shows an error panel instead of crashing when the repo cannot be read", async () => {
		const { lastFrame } = render(<App repoRoot="/nonexistent" />);
		await settle();
		expect(lastFrame()).toMatch(/loading|error|no runs/i);
	});

	it("opens run detail on enter", async () => {
		const { lastFrame, stdin } = render(<App repoRoot={await repoWithRun()} />);
		await settle();
		stdin.write(ENTER);
		await settle();
		expect(lastFrame()).toContain("RUN 1");
	});

	it("moves to the risk screen on r and back on escape", async () => {
		const { lastFrame, stdin } = render(<App repoRoot={await repoWithRun()} />);
		await settle();
		stdin.write(ENTER);
		await settle();
		stdin.write("r");
		await settle();
		expect(lastFrame()).toMatch(/RISK SCORE/i);
		stdin.write(ESCAPE);
		await settle();
		expect(lastFrame()).toContain("RUN 1");
	});

	it("shows the key hints on every screen", async () => {
		const { lastFrame } = render(<App repoRoot={await repoWithRun()} />);
		await settle();
		expect(lastFrame()).toContain("[q]");
	});
});
```

- [ ] **Step 2: Write the shell**

`src/ui/App.tsx` holds three pieces of state: the current screen, the selected run id, and the loaded model. It loads through the read model in an effect, renders a loading panel until the first model arrives, and renders an error panel carrying the message when loading throws. Navigation: arrow keys or `j` and `k` move the selection, Enter opens detail, `v` events, `d` diff, `r` risk, `a` approve, Escape goes back one level, `q` quits. A footer prints the hints for the current screen.

`src/ui/screens/Approve.tsx` shows the run, the verdict, the risk and a confirmation prompt, then calls `approveRun` with `actorFromEnvironment()`. When that throws because the process is inside an agent context, the screen renders the refusal message instead of a prompt. The console offers no way around it.

- [ ] **Step 3: Wire the default command**

In `src/cli/index.ts`, when `rpt` is invoked with no subcommand and stdout is a TTY, render the Ink app. When stdout is not a TTY, print `renderRunList` in text form instead. A piped `rpt` must never emit terminal escape sequences.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run test/ui/App.test.tsx`
Expected: PASS, six tests.

- [ ] **Step 5: Drive the console by hand**

```bash
pnpm build
cd /tmp && rm -rf rpt-demo && mkdir rpt-demo && cd rpt-demo && git init -q
node <path-to-rpt>/dist/cli/index.js init
node <path-to-rpt>/dist/cli/index.js
```

Expected: the dashboard renders, the empty state names `rpt init`, and `q` exits cleanly with the terminal restored.

- [ ] **Step 6: Commit**

```bash
git add src/ui src/cli/index.ts test/ui/App.test.tsx
git commit -m "feat: ink console shell with navigation and human-only approval screen"
```

---

### Task 6: rpt doctor

**Files:**
- Create: `src/app/doctor.ts`
- Modify: `src/cli/index.ts`
- Test: `test/app/doctor.test.ts`

**Interfaces:**
- Consumes: `pruneWorktrees`, `loadPricing`, `loadConfig`, `listRuns`, `git`
- Produces: `Check = { id: string; ok: boolean; detail: string }`; `doctor(repoRoot: string): Promise<Check[]>`

- [ ] **Step 1: Write the failing doctor test**

`test/app/doctor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { doctor, type Check } from "../../src/app/doctor.js";
import { initRepo } from "../../src/app/initRepo.js";
import { makeFixtureRepo } from "../support/fixtureRepo.js";

function check(checks: Check[], id: string): Check | undefined {
	return checks.find((entry) => entry.id === id);
}

describe("doctor", () => {
	it("reports missing agent hooks in an uninitialised repo", async () => {
		expect(check(await doctor(await makeFixtureRepo()), "agent-hooks")?.ok).toBe(false);
	});

	it("reports healthy agent hooks after init", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		expect(check(await doctor(repo), "agent-hooks")?.ok).toBe(true);
	});

	it("reports the git gate hook after init", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		expect(check(await doctor(repo), "git-hooks")?.ok).toBe(true);
	});

	it("flags an unset pricing table rather than staying quiet", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		expect(check(await doctor(repo), "pricing")?.ok).toBe(false);
	});

	it("reports config validity", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		expect(check(await doctor(repo), "config")?.ok).toBe(true);
	});

	it("reports no orphaned worktrees in a clean repo", async () => {
		const repo = await makeFixtureRepo();
		await initRepo(repo);
		expect(check(await doctor(repo), "worktrees")?.ok).toBe(true);
	});

	it("returns every check even when one fails", async () => {
		expect((await doctor(await makeFixtureRepo())).length).toBeGreaterThanOrEqual(5);
	});
});
```

- [ ] **Step 2: Write doctor**

`src/app/doctor.ts` runs each check independently, catching per check so one failure never hides the rest. Checks: `agent-hooks` reads `.claude/settings.json` for the `rpt hook` command; `git-hooks` reads `.git/hooks/pre-commit` for the rpt marker; `config` calls `loadConfig` and reports any validation error as its detail; `pricing` reports how many models across recorded runs lack a rate; `worktrees` calls `pruneWorktrees` and reports how many it removed; `daemon` reports whether the socket exists and accepts a connection.

- [ ] **Step 3: Add the command**

`rpt doctor` prints one line per check with a leading `ok` or `!!` marker and exits 1 when any check failed, so it can be used in CI.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run test/app/doctor.test.ts`
Expected: PASS, seven tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/doctor.ts src/cli/index.ts test/app/doctor.test.ts
git commit -m "feat: rpt doctor diagnosing hooks, config, pricing and worktrees"
```

---

### Task 7: Claude Code slash command plugin

**Files:**
- Create: `plugin/.claude-plugin/plugin.json`
- Create: `plugin/commands/status.md`
- Create: `plugin/commands/verify.md`
- Create: `plugin/commands/risk.md`
- Create: `plugin/commands/diff.md`
- Create: `plugin/README.md`
- Test: `test/plugin/readOnly.test.ts`

**Interfaces:**
- Consumes: the `rpt` binary and its `--format=agent` output
- Produces: an installable Claude Code plugin exposing `/rpt:status`, `/rpt:verify`, `/rpt:risk`, `/rpt:diff`

- [ ] **Step 1: Confirm the plugin and command file format**

Do not write the manifest from memory. Check the current Claude Code plugin and slash command schema first, either with the `claude-code-guide` agent or from the official documentation, and record the version checked against in `plugin/README.md`. If the real schema differs from what this task assumes, follow the real schema and adjust the test.

- [ ] **Step 2: Write the failing plugin test**

`test/plugin/readOnly.test.ts`:

```ts
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const COMMANDS = "plugin/commands";

async function commandBodies(): Promise<string[]> {
	const files = await readdir(COMMANDS);
	return Promise.all(files.map((file) => readFile(join(COMMANDS, file), "utf8")));
}

describe("the agent surface is read only", () => {
	it("ships exactly the four read-only commands", async () => {
		expect((await readdir(COMMANDS)).sort()).toEqual(["diff.md", "risk.md", "status.md", "verify.md"]);
	});

	it("never invokes approve or reject", async () => {
		for (const body of await commandBodies()) {
			expect(body).not.toMatch(/rpt\s+(approve|reject)/);
		}
	});

	it("never sets the bypass variable", async () => {
		for (const body of await commandBodies()) {
			expect(body).not.toContain("RPT_BYPASS");
		}
	});

	it("always requests the agent output format", async () => {
		for (const body of await commandBodies()) {
			expect(body).toContain("--format=agent");
		}
	});

	it("declares a plugin manifest with a name and version", async () => {
		const manifest = JSON.parse(await readFile("plugin/.claude-plugin/plugin.json", "utf8"));
		expect(typeof manifest.name).toBe("string");
		expect(typeof manifest.version).toBe("string");
	});
});
```

- [ ] **Step 3: Write the commands**

Each command file instructs the agent to run one rpt invocation and report its output verbatim. `status.md` runs `rpt status --format=agent`. `verify.md` runs `rpt verify $ARGUMENTS --format=agent`, defaulting to the active run when no argument is given. Keep each body short: the value is the rpt output, not prose around it.

Every command file ends with the same line, because an agent reading its own verdict needs to know the boundary:

> This output is produced by rpt, independently of you. If it disagrees with what you believe you did, rpt's observation is the record. You cannot approve or clear a run.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run test/plugin/readOnly.test.ts`
Expected: PASS, five tests.

- [ ] **Step 5: Install and exercise the plugin by hand**

Install the local plugin into a scratch project, run a short Claude Code session that edits a file, then invoke `/rpt:status` and `/rpt:risk` inside that session. Confirm the output appears in the transcript and that no slash command can approve the run.

- [ ] **Step 6: Commit**

```bash
git add plugin test/plugin
git commit -m "feat: read-only claude code slash commands for the agent surface"
```

---

### Task 8: Agent output budget

**Files:**
- Modify: `src/cli/render.ts`, `src/cli/renderRisk.ts`
- Test: `test/cli/agentBudget.test.ts`

**Interfaces:**
- Consumes: every `--format=agent` renderer

- [ ] **Step 1: Write the budget test**

`test/cli/agentBudget.test.ts`. This output is injected into an agent's context on every invocation, so its size is a correctness property rather than a nicety.

```ts
import { describe, expect, it } from "vitest";
import type { AgentRun } from "../../src/domain/run.js";
import { renderRun } from "../../src/cli/render.js";
import { renderRisk } from "../../src/cli/renderRisk.js";
import type { RiskAssessment } from "../../src/risk/assess.js";

const bigRun: AgentRun = {
	id: 1842,
	task: "x".repeat(300),
	state: "VERIFIED",
	baseSha: "a".repeat(40),
	endSha: "b".repeat(40),
	startedAt: "2026-09-09T10:00:00.000Z",
	endedAt: "2026-09-09T10:08:41.000Z",
	hasGaps: false,
	claims: {
		mutatedPaths: Array.from({ length: 300 }, (_, index) => `src/deep/nested/path/file-${index}.ts`),
		commands: Array.from({ length: 200 }, (_, index) => `command ${index}`),
	},
	usage: [],
};

const bigRisk: RiskAssessment = {
	score: 88,
	level: "CRITICAL",
	contributions: Array.from({ length: 40 }, (_, index) => ({
		id: `rule-${index}`,
		label: "A fairly long human readable rule label that would bloat output",
		points: index,
	})),
};

describe("agent output budget", () => {
	it("keeps a run summary under 600 characters however large the run", () => {
		expect(renderRun(bigRun, "agent").length).toBeLessThan(600);
	});

	it("keeps a risk summary under 800 characters however many rules fired", () => {
		expect(renderRisk(bigRisk, "agent").length).toBeLessThan(800);
	});

	it("still names the score and level after truncation", () => {
		const output = renderRisk(bigRisk, "agent");
		expect(output).toContain("88");
		expect(output).toContain("CRITICAL");
	});

	it("says how much was elided rather than truncating silently", () => {
		expect(renderRisk(bigRisk, "agent")).toMatch(/\d+ more/);
	});
});
```

- [ ] **Step 2: Make the agent renderers respect the budget**

Cap the agent format at the highest-magnitude contributions and append a line stating how many were omitted. Truncate a long task to its first 80 characters. Never truncate the score, the level or the verdict.

- [ ] **Step 3: Run the test and confirm it passes**

Run: `pnpm vitest run test/cli/agentBudget.test.ts`
Expected: PASS, four tests.

- [ ] **Step 4: Commit**

```bash
git add src/cli test/cli/agentBudget.test.ts
git commit -m "feat: bound agent output so it never floods a context window"
```

---

### Task 9: Packaging and release readiness

**Files:**
- Modify: `package.json`
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`
- Create: `docs/limits.md`

**Interfaces:**
- Consumes: everything

- [ ] **Step 1: Make the package installable**

Add `files`, `exports`, `repository`, `license` and `publishConfig` with `"access": "public"` to `package.json`. Add a `prepublishOnly` script running `pnpm typecheck && pnpm test && pnpm build`.

- [ ] **Step 2: Verify the packed contents**

```bash
pnpm pack --dry-run
```

Expected: `dist/`, `plugin/`, `README.md` and `package.json` only. No `test/`, no `.rpt/`, no fixtures.

- [ ] **Step 3: Verify a global install works from the tarball**

```bash
pnpm pack
npm install -g ./klyne-rpt-0.1.0.tgz
cd /tmp && rm -rf rpt-install-check && mkdir rpt-install-check && cd rpt-install-check && git init -q
rpt init && rpt doctor
```

Expected: `rpt init` succeeds, and `rpt doctor` reports hooks installed, config valid and pricing unset. Uninstall afterwards.

- [ ] **Step 4: Add CI**

`.github/workflows/ci.yml` runs on push and pull request: install pnpm, install dependencies, then `pnpm typecheck`, `pnpm test:cov` and `pnpm build`. The job fails when coverage drops below the configured thresholds.

- [ ] **Step 5: Write the limits document**

`docs/limits.md` states plainly what rpt does not establish, so nobody mistakes a green verdict for more than it is:

- rpt verifies that the tests the repo already has still pass. It cannot tell you those tests are good.
- Change coverage measures execution, not assertion. A line can be covered by a test that asserts nothing.
- The secret scanner matches shapes and entropy. It will miss novel formats and will occasionally flag a random-looking constant.
- The dependency audit is only as current as the ecosystem's advisory database.
- Risk scores are a configured heuristic, not a measurement. The default weights are a starting point to be tuned per repo.
- A bypassed commit is recorded but not prevented. rpt raises the cost of skipping the gate; it does not make it impossible.
- rpt observes one agent, Claude Code. A change made outside an observed run is invisible to it.

- [ ] **Step 6: Finish the README**

Cover install, quickstart, the mental model of a run, every command, the config file, the slash commands, where data lives, the attestation format, and a link to `docs/limits.md`.

- [ ] **Step 7: Run the whole suite one last time**

Run: `pnpm typecheck && pnpm test:cov && pnpm build`
Expected: all green, coverage at or above 80 on all four measures.

- [ ] **Step 8: Review the whole project**

Dispatch the `swe:swe` agent over the complete diff from the first commit. Fix every violation. Then dispatch `swe:clean-code` in review mode over `src/` and fix what it reports.

- [ ] **Step 9: Commit**

```bash
git add package.json .github README.md docs/limits.md
git commit -m "chore: packaging, ci, readme and an explicit limits document"
```

---

## Plan 3 self-review

**Spec coverage.** Section 17's Ink surface is Tasks 2 to 5, covering all six screens and the documented key bindings. The slash plugin is Task 7. `rpt doctor` is Task 6. Section 5's rule that `ui/` imports only from `app/` is enforced by the boundary test in Task 1. Section 12's human-only approval is re-asserted at the console layer in Task 5, going through the same `assertHuman` path rather than a parallel one. Section 22 packaging is Task 9.

**Full spec coverage across the three plans.** Sections 1 through 9 and 14 through 16 are Plan 1. Sections 10 through 13 are Plan 2. Sections 17, 18 and 22 finish here. No spec section is left unimplemented.

**Type consistency.** `RunSummary` and `RunDetailModel` are defined once in Task 1 and consumed unchanged by every screen. `RiskLevel` and `RiskAssessment` come from `src/risk/assess.ts` throughout. `Approval` and `Actor` come from `src/app/approveRun.ts`. Every screen takes exactly one prop named `model`, except `Diff`, which takes `patch`, because a patch is a string rather than a model.

**Two places this plan deliberately withholds detail.** Tasks 3 and 4 describe screen layout in prose rather than giving full component source, because the tests fully specify the observable behaviour and the layout is the one part a human will want to adjust by eye. Task 7 refuses to write the plugin manifest from memory and requires checking the current schema first. Both are intentional, not omissions.
