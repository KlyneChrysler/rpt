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

describe("projectRun task derivation (controller ruling)", () => {
	it("keeps the RunStarted task even when a PromptSubmitted follows", () => {
		const run = projectRun(
			1,
			log(
				draft("RunStarted", { task: "fix auth", baseSha: "abc" }),
				draft("PromptSubmitted", { prompt: "please refactor the login flow" }),
			),
		);
		expect(run.task).toBe("fix auth");
	});

	it("takes the task from the first PromptSubmitted when RunStarted carries none", () => {
		const run = projectRun(
			1,
			log(
				draft("RunStarted", { baseSha: "abc" }),
				draft("PromptSubmitted", { prompt: "fix the auth bug" }),
			),
		);
		expect(run.task).toBe("fix the auth bug");
	});

	it("does not let a second PromptSubmitted overwrite the established task", () => {
		const run = projectRun(
			1,
			log(
				draft("RunStarted", { baseSha: "abc" }),
				draft("PromptSubmitted", { prompt: "first task" }),
				draft("PromptSubmitted", { prompt: "second task" }),
			),
		);
		expect(run.task).toBe("first task");
	});

	it("takes only the first non-empty line of a multi-line prompt", () => {
		const run = projectRun(
			1,
			log(
				draft("RunStarted", { baseSha: "abc" }),
				draft("PromptSubmitted", { prompt: "\n   \nfix the auth bug\nwith extra context below\n" }),
			),
		);
		expect(run.task).toBe("fix the auth bug");
	});

	it("caps the derived task at 120 characters", () => {
		const longLine = "x".repeat(150);
		const run = projectRun(
			1,
			log(draft("RunStarted", { baseSha: "abc" }), draft("PromptSubmitted", { prompt: longLine })),
		);
		expect(run.task).toBe("x".repeat(120));
		expect(run.task.length).toBe(120);
	});

	it("leaves the task empty when neither RunStarted nor any PromptSubmitted supplies one", () => {
		const run = projectRun(1, log(draft("RunStarted", { baseSha: "abc" }), draft("FileMutated", { path: "a.ts" })));
		expect(run.task).toBe("");
	});
});
