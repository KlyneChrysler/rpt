import { loadConfig } from "../config/load.js";
import type { RptConfig } from "../config/schema.js";
import { fingerprintOf } from "../domain/checksum.js";
import { isValidApproverName, type Approval, type ApprovalDecision, type RiskContribution } from "../domain/approval.js";
import type { AgentEvent, EventKind, RunId } from "../domain/events.js";
import { decide, RISK_LEVELS, type RiskLevel } from "../domain/policy.js";
import { applyApprovalDecision } from "../domain/run.js";
import type { VerdictName } from "../domain/verdict.js";
import { assessRisk } from "../risk/assess.js";
import { buildFacts } from "../risk/facts.js";
import { appendEventIfNoneOfKind, readEvents } from "../store/eventLog.js";
import { readApproval as readApprovalRecord, writeApproval } from "../store/approvals.js";
import { rptDirOf } from "../store/paths.js";
import { upsertRun } from "../store/runIndex.js";
import { loadRun } from "./loadRun.js";
import { loadRunConfig } from "./loadRunConfig.js";
import { readFromControllingTerminal } from "./terminalConfirm.js";
import { readVerdict } from "./verifyRun.js";

const APPROVAL_EVENT_KINDS: readonly EventKind[] = ["ApprovalGranted", "ApprovalDenied"];

// "agent": a known marker was found - an absolute refusal. "unknown": no
// marker was found, which is not proof no agent is present - a silent
// environment must not be read as proof of a human. Neither value is what
// actually authorises a decision any more (see record() below); this is a
// cheap, no-I/O pre-check that spares an honest agent-marked caller from
// ever reaching the real one.
export type AgentContextSignal = "agent" | "human" | "unknown";

export type Actor = { name: string; interactive: boolean; agentContext: AgentContextSignal };

// Environment inspection alone can prove "agent" (a known marker is
// present) but never "human" - there is no environment variable or TTY flag
// that positively establishes a person is present, only the absence of
// evidence for an agent. This function is honest about that limit: it never
// returns agentContext: "human". The actual proof of a human now lives in
// record()'s mandatory typed confirmation (see below), which is
// unconditional for any actor that reaches it - so an Actor's agentContext
// and interactive fields are a fast pre-check, not the gate itself.
export function actorFromEnvironment(): Actor {
	return {
		name: process.env.USER ?? process.env.LOGNAME ?? "unknown",
		interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
		agentContext: knownAgentMarkerPresent() ? "agent" : "unknown",
	};
}

function knownAgentMarkerPresent(): boolean {
	return process.env.RPT_AGENT_CONTEXT === "1" || process.env.CLAUDECODE === "1";
}

export function approveRun(repoRoot: string, runId: RunId, actor: Actor): Promise<Approval> {
	return record(repoRoot, runId, actor, "approved");
}

export function rejectRun(repoRoot: string, runId: RunId, actor: Actor): Promise<Approval> {
	return record(repoRoot, runId, actor, "rejected");
}

// override is never trusted from disk. A hand-edited approval.json could
// claim override: false for a run that was never VERIFIED; re-deriving it
// from the verdict on every read, rather than returning whatever the file
// says, keeps there being one source of truth for that claim instead of two
// copies with nothing binding them.
export async function readApproval(repoRoot: string, runId: RunId): Promise<Approval | null> {
	const raw = await readApprovalRecord(rptDirOf(repoRoot), runId);
	if (raw === null) return null;
	const verdict = await readVerdict(repoRoot, runId);
	if (verdict === null) {
		throw new Error(`run ${runId} has a recorded decision but no verdict to derive its override flag from`);
	}
	return { ...raw, override: verdict.name !== "VERIFIED" };
}

async function record(repoRoot: string, runId: RunId, actor: Actor, decision: ApprovalDecision): Promise<Approval> {
	assertHuman(actor);
	if (!isValidApproverName(actor.name)) {
		throw new Error("approver name is empty, too long, or contains a disallowed character");
	}

	const rptDir = rptDirOf(repoRoot);
	if ((await readApproval(repoRoot, runId)) !== null) {
		throw new Error(`run ${runId} already has a recorded decision`);
	}

	const run = await loadRun(repoRoot, runId);
	const verdict = await readVerdict(repoRoot, runId);
	if (verdict === null) throw new Error(`run ${runId} has not been verified yet`);

	// A run whose projected state already shows this exact outcome, with no
	// approval.json on disk, is not a fresh decision - it is a prior attempt
	// whose event append succeeded and whose file write did not. Heal from
	// the event's own recorded payload rather than the live inputs of this
	// call: rebuilding from live actor/config/risk would let a healing retry
	// silently record a different approver than the event says, or re-run a
	// gate that already ran once, against a score that may have moved bands
	// since - permanently stuck if it now disagrees. The event is the
	// decision; this call is only finishing writing it down.
	const outcomeState = decision === "approved" ? "APPROVED" : "REJECTED";
	if (run.state === outcomeState) {
		const approval = await approvalFromRecordedEvent(rptDir, runId, decision);
		await writeApproval(rptDir, approval);
		await upsertRun(rptDir, { id: runId, task: run.task, state: outcomeState, startedAt: run.startedAt, endedAt: run.endedAt });
		return approval;
	}

	// Throws (IllegalTransitionError, via applyApprovalDecision) for a run
	// this decision cannot legally apply to: never verified, already decided
	// the other way, or already recorded - a state precondition enforced by
	// the same transition graph the projection itself uses.
	applyApprovalDecision(run.state, verdict.name, decision);

	const snapshot = await loadRunConfig(repoRoot, runId);
	const configChangedSinceSnapshot = await hasConfigDrifted(repoRoot, snapshot);
	const { level, score, contributions } = assessRisk(buildFacts(verdict.results, snapshot, configChangedSinceSnapshot), snapshot);
	const configFingerprint = fingerprintOf(snapshot);

	// Gated on decision === "approved" only, and that qualifier must never be
	// dropped: rejecting a CRITICAL run is not a sign-off, it is a human
	// saying no to a dangerous change, which this project wants recorded,
	// not blocked. This is the only critical prohibition in the codebase -
	// decide() returning "block" for CRITICAL has no other enforcement point
	// anywhere else. If this check is ever "simplified" by dropping the
	// decision guard, or deleted because it looks redundant with
	// applyApprovalDecision above, nothing stops a critical run from being
	// approved.
	if (decision === "approved" && decide(verdict.name, level) === "block") {
		throw new Error(`run ${runId} is CRITICAL risk and cannot be approved - the change must be reduced, not signed off`);
	}

	// The load-bearing check of the whole project, moved here (rather than
	// living beside the gate in a struct a caller supplies) so that
	// bypassing it means not calling approveRun/rejectRun at all, not
	// calling them with a convenient Actor literal. Bound to this specific
	// run, decision, verdict and risk level: a typed "yes" captured once is
	// not a reusable capability that authorises any other decision.
	await requireTypedConfirmation(runId, decision, verdict.name, level);

	const approval: Approval = {
		runId,
		decision,
		by: actor.name,
		at: new Date().toISOString(),
		override: verdict.name !== "VERIFIED",
		level,
		score,
		contributions,
		configFingerprint,
	};

	// The event log is the source of truth, so it is appended first - and
	// the read that checks no approval/rejection already exists, and the
	// append itself, happen under one held lock (appendEventIfNoneOfKind),
	// so two concurrent callers cannot both observe "not yet decided" and
	// both append. Losing that race here (conflicting !== null) means
	// someone else recorded a decision in the time between this call's own
	// earlier checks and this append; refuse rather than also writing a
	// second file over what just became the real record.
	const result = await appendEventIfNoneOfKind(rptDir, runId, APPROVAL_EVENT_KINDS, {
		ts: approval.at,
		source: "rpt",
		kind: decision === "approved" ? "ApprovalGranted" : "ApprovalDenied",
		payload: {
			by: approval.by,
			override: approval.override,
			level,
			score,
			contributions,
			configFingerprint,
			verdictName: verdict.name,
		},
	});
	if (result.appended === null) {
		throw new Error(`run ${runId} already has a recorded decision`);
	}

	await writeApproval(rptDir, approval);
	await upsertRun(rptDir, { id: runId, task: run.task, state: outcomeState, startedAt: run.startedAt, endedAt: run.endedAt });
	return approval;
}

async function approvalFromRecordedEvent(rptDir: string, runId: RunId, decision: ApprovalDecision): Promise<Approval> {
	const { events } = await readEvents(rptDir, runId);
	const kind = decision === "approved" ? "ApprovalGranted" : "ApprovalDenied";
	const recorded = events.find((event) => event.kind === kind);
	if (recorded === undefined) {
		throw new Error(`run ${runId} appears already ${decision} but no ${kind} event could be found to heal from`);
	}
	return approvalFromEventPayload(runId, decision, recorded);
}

function approvalFromEventPayload(runId: RunId, decision: ApprovalDecision, event: AgentEvent): Approval {
	const by = typeof event.payload.by === "string" ? event.payload.by : null;
	const level = riskLevelOf(event.payload.level);
	const score = typeof event.payload.score === "number" ? event.payload.score : null;
	const contributions = riskContributionsOf(event.payload.contributions);
	const configFingerprint = typeof event.payload.configFingerprint === "string" ? event.payload.configFingerprint : null;
	if (by === null || !isValidApproverName(by) || level === null || score === null || contributions === null || configFingerprint === null) {
		throw new Error(`run ${runId} has a recorded ${event.kind} event whose payload cannot be healed from`);
	}
	return { runId, decision, by, at: event.ts, override: Boolean(event.payload.override), level, score, contributions, configFingerprint };
}

function riskLevelOf(value: unknown): RiskLevel | null {
	return (RISK_LEVELS as readonly unknown[]).includes(value) ? (value as RiskLevel) : null;
}

function riskContributionsOf(value: unknown): RiskContribution[] | null {
	if (!Array.isArray(value)) return null;
	const contributions: RiskContribution[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) return null;
		const { id, label, points } = entry as Record<string, unknown>;
		if (typeof id !== "string" || typeof label !== "string" || typeof points !== "number") return null;
		contributions.push({ id, label, points });
	}
	return contributions;
}

// Compares this run's config snapshot against a live read taken right now,
// so an edit timed for after the snapshot - including one that never
// appears in the sealed diff at all - still shows up as drift rather than
// being invisible to both the gate and the risk rule that scores it. A live
// read that fails outright (rpt.config.json now unreadable or invalid) is
// treated as drift too: an unreadable config is not evidence nothing
// changed, and erring toward flagging risk is this project's accepted
// direction to be wrong in.
async function hasConfigDrifted(repoRoot: string, snapshot: RptConfig): Promise<boolean> {
	let live: RptConfig;
	try {
		live = await loadConfig(repoRoot);
	} catch {
		return true;
	}
	return JSON.stringify(live) !== JSON.stringify(snapshot);
}

async function requireTypedConfirmation(runId: RunId, decision: ApprovalDecision, verdictName: VerdictName, level: RiskLevel): Promise<void> {
	const phrase = confirmationPhrase(runId, decision, verdictName, level);
	const prompt = `rpt: type "${phrase}" at this terminal to confirm ${decisionVerb(decision)} run ${runId}: `;
	let typed: string;
	try {
		typed = await readFromControllingTerminal(prompt);
	} catch (error) {
		throw new Error(
			`approval requires a confirmation typed at the controlling terminal, which could not be opened: ${errorMessage(error)}`,
		);
	}
	if (typed.trim() !== phrase) {
		throw new Error(`typed confirmation did not match this decision - refusing to record it`);
	}
}

// Exported so tests can compute the exact phrase a given decision requires,
// rather than either hard-coding the production format string a second time
// or (worse) mocking the confirmation to always succeed regardless of what
// was asked. Binding every field into the phrase - not just the run id - is
// what makes a captured confirmation unreusable against a different
// decision, verdict or risk level for the same run.
export function confirmationPhrase(runId: RunId, decision: ApprovalDecision, verdictName: VerdictName, level: RiskLevel): string {
	return `${decision} run ${runId} verdict ${verdictName} risk ${level}`;
}

function decisionVerb(decision: ApprovalDecision): string {
	return decision === "approved" ? "approving" : "rejecting";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Two independent conditions, both required - a terminal check alone is
// defeated by an agent that has one; an agent-context check alone is
// defeated by an agent whose environment does not advertise itself. This is
// the cheap pre-check only: see record()'s mandatory typed confirmation for
// what actually proves a human is present.
function assertHuman(actor: Actor): void {
	if (actor.agentContext === "agent") {
		throw new Error("approval must come from a human, and this process is running inside a known agent context");
	}
	if (actor.agentContext === "unknown") {
		throw new Error(
			"approval requires a definite human context, and whether this process is running inside an agent context could not be determined",
		);
	}
	if (!actor.interactive) {
		throw new Error("approval requires an interactive terminal");
	}
}
