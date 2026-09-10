import { describe, expect, it } from "vitest";
import type { AgentEvent, DraftEvent } from "../../src/domain/events.js";
import { applyApprovalDecision, projectRun } from "../../src/domain/run.js";

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

	it("collects commands as claims without deduplicating, ignoring empty strings", () => {
		const run = projectRun(
			1,
			log(
				draft("RunStarted", { task: "t", baseSha: "abc" }),
				draft("CommandStarted", { command: "npm test" }),
				draft("CommandStarted", { command: "npm test" }),
				draft("CommandStarted", { command: "" }),
			),
		);
		expect(run.claims.commands).toEqual(["npm test", "npm test"]);
	});
});

// Regression coverage for a real defect: before this, ApprovalGranted and
// ApprovalDenied fell through the reducer's default case, so replaying the
// event log - the documented recovery path for a damaged index - lost every
// approval. The index cache was the only place an approval was ever visible.
describe("projectRun folds approval events", () => {
	function verifyingRun(...tail: DraftEvent[]): AgentEvent[] {
		return log(
			draft("RunStarted", { task: "t", baseSha: "abc" }),
			draft("AgentStopped", { endSha: "def" }),
			draft("VerificationStarted", {}),
			...tail,
		);
	}

	it("moves to APPROVED, through AWAITING_APPROVAL, on an ApprovalGranted event", () => {
		const run = projectRun(1, verifyingRun(draft("ApprovalGranted", { verdictName: "VERIFIED" })));
		expect(run.state).toBe("APPROVED");
	});

	it("moves to REJECTED on an ApprovalDenied event", () => {
		const run = projectRun(1, verifyingRun(draft("ApprovalDenied", { verdictName: "FAILED" })));
		expect(run.state).toBe("REJECTED");
	});

	// Regression coverage for the second defect this round found: an illegal
	// transition used to throw straight out of the fold, so one duplicate or
	// malformed approval event permanently bricked the run - loadRun, rpt
	// status, and approveRun/rejectRun's own precondition check could never
	// succeed again. It is folded into hasGaps instead, the same way a torn
	// event log line already is, so the run stays loadable and the anomaly is
	// flagged rather than fatal.
	it("marks the run gapped, without throwing, when an approval event carries an unrecognised verdict name", () => {
		const run = projectRun(1, verifyingRun(draft("ApprovalGranted", { verdictName: "NONSENSE" })));
		expect(run.hasGaps).toBe(true);
		expect(run.state).toBe("VERIFYING");
	});

	it("marks the run gapped, without throwing, replaying a second approval event for a run already decided", () => {
		const run = projectRun(
			1,
			verifyingRun(
				draft("ApprovalGranted", { verdictName: "VERIFIED" }),
				draft("ApprovalGranted", { verdictName: "VERIFIED" }),
			),
		);
		expect(run.hasGaps).toBe(true);
		// The first, legitimate event still took effect - a duplicate does not
		// erase the real decision, only flags itself as suspicious.
		expect(run.state).toBe("APPROVED");
	});

	it("marks the run gapped, without throwing, on a rejection conflicting with a prior approval", () => {
		const run = projectRun(
			1,
			verifyingRun(
				draft("ApprovalGranted", { verdictName: "VERIFIED" }),
				draft("ApprovalDenied", { verdictName: "VERIFIED" }),
			),
		);
		expect(run.hasGaps).toBe(true);
		expect(run.state).toBe("APPROVED");
	});
});

describe("applyApprovalDecision", () => {
	it("walks VERIFYING through the verdict and AWAITING_APPROVAL to APPROVED", () => {
		expect(applyApprovalDecision("VERIFYING", "VERIFIED", "approved")).toBe("APPROVED");
	});

	it("walks a failed verdict to REJECTED", () => {
		expect(applyApprovalDecision("VERIFYING", "FAILED", "rejected")).toBe("REJECTED");
	});

	it("refuses a run that has not reached VERIFYING", () => {
		expect(() => applyApprovalDecision("ENDED", "VERIFIED", "approved")).toThrow();
	});

	it("refuses a run that is already recorded", () => {
		expect(() => applyApprovalDecision("RECORDED", "VERIFIED", "approved")).toThrow();
	});

	it("refuses re-approving a run that is already approved", () => {
		expect(() => applyApprovalDecision("APPROVED", "VERIFIED", "approved")).toThrow();
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

	it("leaves the task empty when the first PromptSubmitted has no non-empty line, even if a later one does", () => {
		const run = projectRun(
			1,
			log(
				draft("RunStarted", { baseSha: "abc" }),
				draft("PromptSubmitted", { prompt: "   \n  \n" }),
				draft("PromptSubmitted", { prompt: "real task here" }),
			),
		);
		expect(run.task).toBe("");
	});
});
