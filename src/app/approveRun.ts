import { fingerprintOf } from "../domain/checksum.js";
import { isValidApproverName, type Approval, type ApprovalDecision, type RiskContribution } from "../domain/approval.js";
import type { AgentEvent, EventKind, RunId } from "../domain/events.js";
import { decide, RISK_LEVELS, type RiskLevel } from "../domain/policy.js";
import { applyApprovalDecision, isValidApprovalEvent } from "../domain/run.js";
import type { Verdict, VerdictName } from "../domain/verdict.js";
import { appendEventIfNoneOfKind, readEvents } from "../store/eventLog.js";
import { readApproval as readApprovalRecord, writeApproval } from "../store/approvals.js";
import { rptDirOf } from "../store/paths.js";
import { upsertRun } from "../store/runIndex.js";
import { assessRun } from "./assessRun.js";
import { loadRun } from "./loadRun.js";
import { resolveRunConfig } from "./loadRunConfig.js";
import { readFromControllingTerminal } from "./terminalConfirm.js";
import { readVerdict } from "./verifyRun.js";

const APPROVAL_EVENT_KINDS: readonly EventKind[] = ["ApprovalGranted", "ApprovalDenied"];

// "agent": a known marker was found - an absolute refusal, no confirmation
// can override it. "human" / "unknown" are treated identically by
// assertHuman below, on purpose: environment inspection can prove "agent"
// but never "human" (see actorFromEnvironment), so a gate that hard-refused
// "unknown" was unsatisfiable by any honest caller - which meant the task of
// wiring a real command around this, told not to touch gating logic, would
// have had nowhere to go but hardcoding a fabricated "human" claim at the
// call site, permanently. That is worse than what it defends against:
// record()'s mandatory typed confirmation (see below) is unconditional and
// decision-bound proof, strictly stronger than this pre-check ever was, so
// letting "unknown" fall through to it - rather than refusing before ever
// offering the chance - costs nothing a real bypass could not already do by
// scripting the confirmation too, and gains a gate an honest caller can
// actually pass.
export type AgentContextSignal = "agent" | "human" | "unknown";

export type Actor = { name: string; interactive: boolean; agentContext: AgentContextSignal };

// Environment inspection alone can prove "agent" (a known marker is
// present) but never "human" - there is no environment variable or TTY flag
// that positively establishes a person is present, only the absence of
// evidence for an agent. This function is honest about that limit: it never
// returns agentContext: "human". The actual proof of a human lives entirely
// in record()'s mandatory typed confirmation (see below), which is
// unconditional for any actor that reaches it - so an Actor's agentContext
// and interactive fields are a fast pre-check for a known agent, not the
// gate itself.
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

	const outcomeState = decision === "approved" ? "APPROVED" : "REJECTED";

	// Throws (IllegalTransitionError, via applyApprovalDecision) for a run
	// this decision cannot legally apply to: never verified, already
	// recorded, or already decided - including, on purpose, the exact same
	// outcome with the file missing. That last case used to be treated as an
	// implicit "heal": reconstruct and write the approval right here, no
	// gate, no confirmation, because record() had "already" decided once.
	// It let a forged event - one an agent wrote directly, claiming CRITICAL
	// risk and a name that was never present - turn into a genuine-looking
	// approval.json the moment anyone next called approveRun for that run,
	// with nobody asked and nothing checked. Recovering that case is now
	// healApproval's job, an explicitly separate operation a person has to
	// choose, not a branch record() falls into by being called twice with
	// the same arguments.
	applyApprovalDecision(run.state, verdict.name, decision);

	const { assessment, config: riskConfig } = await assessRun(repoRoot, run, verdict);
	const { level, score, contributions } = assessment;
	const configFingerprint = fingerprintOf(riskConfig);

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
	//
	// isValidApprovalEvent, not a bare kind match, decides what counts as a
	// real conflict: a single malformed approval-kind event (an invalid
	// verdict name, say) that the reducer's own fold already gaps rather
	// than applies used to wedge every future decision here - refused with
	// "already has a recorded decision", which was false, since nothing had
	// actually been recorded - while healApproval separately, correctly,
	// found nothing valid to heal from, leaving no path forward at all.
	// run.state, captured before this call reached this point, is already
	// proof no *valid* approval-kind event exists yet (applyApprovalDecision
	// above would have thrown otherwise), so any matching-kind event found
	// here that does not itself validly apply from that same state is noise
	// the fold already rejected, not a real decision to defer to.
	const result = await appendEventIfNoneOfKind(
		rptDir,
		runId,
		APPROVAL_EVENT_KINDS,
		{
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
		},
		(event) => isValidApprovalEvent(run.state, event),
	);
	if (result.appended === null) {
		throw new Error(`run ${runId} already has a recorded decision`);
	}

	await writeApproval(rptDir, approval);
	await upsertRun(rptDir, { id: runId, task: run.task, state: outcomeState, startedAt: run.startedAt, endedAt: run.endedAt });
	return approval;
}

// Healing is an explicit, separately-named operation with its own contract,
// not a branch of record() that a caller falls into by retrying
// approveRun/rejectRun with the same arguments. Four rounds running, the
// critical prohibition kept being enforced at one call site and then found
// reachable through another - record() never consulted risk at all, then
// the confirmation lived beside the gate instead of inside it, then this
// function's old implicit form returned a recorded approval before risk was
// computed and before the gate, and then - the general lesson worth
// keeping - splitting record() into two functions moved the checks that
// used to guard both paths (the actor argument, assertHuman, the approver
// allowlist, the typed confirmation) onto only the one the author was
// looking at. healApproval had none of them: an unambiguous agent context,
// no terminal, and a terminal reader rigged to throw were all still enough
// to heal a forged event naming a human who was never present, at a risk
// level the run did not have. It now takes the same Actor and runs the
// same assertHuman/approver-name checks record() does, plus the same typed
// confirmation - built from the level and verdict *recorded in the event*,
// not a fresh assessment, which asks nothing new of the risk engine and
// breaks no rule about not re-judging a decision against today's score.
//
// What healing asks for once that is true, stated plainly rather than
// framed as "not meant to be stronger than a fresh decision" (a framing
// that used a genuinely narrow, unclosable limit to quietly cover a much
// wider, avoidable gap): a fresh decision requires a non-agent actor, an
// allowlisted approver name, and a typed phrase bound to a fresh
// assessment. Healing now requires the same actor, the same name check,
// and the same typed phrase - bound to the recorded assessment instead of
// a fresh one, and additionally checks the event's verdict name and config
// fingerprint against what is actually on disk (see below), which a fresh
// decision has no analogous check for, because a fresh decision does not
// read a historical claim at all. The one thing that remains genuinely
// unclosable: a human confirming a heal cannot re-derive the recorded
// level from recorded data alone - they are trusting that the level in
// the event once came from a real assessment, the same way anyone reading
// any historical record trusts it was accurate when written. That is the
// actual residual gap, and it is narrow.
export async function healApproval(repoRoot: string, runId: RunId, actor: Actor, decision: ApprovalDecision): Promise<Approval> {
	assertHuman(actor);
	if (!isValidApproverName(actor.name)) {
		throw new Error("approver name is empty, too long, or contains a disallowed character");
	}

	const rptDir = rptDirOf(repoRoot);
	if ((await readApproval(repoRoot, runId)) !== null) {
		throw new Error(`run ${runId} already has a recorded decision`);
	}

	const run = await loadRun(repoRoot, runId);
	const outcomeState = decision === "approved" ? "APPROVED" : "REJECTED";
	if (run.state !== outcomeState) {
		throw new Error(`run ${runId} has no recorded ${decision} event to heal - there is nothing to recover`);
	}

	const verdict = await readVerdict(repoRoot, runId);
	if (verdict === null) throw new Error(`run ${runId} has not been verified yet`);

	const approval = await approvalFromRecordedEvent(rptDir, runId, decision, verdict);

	// The fields the record exists to make drift detectable with are not
	// trusted just because they have the right shape: configFingerprint must
	// match either what this run's own RunStarted recorded, or what
	// resolving this run's config produces right now - not merely "any
	// string that looks like a fingerprint". A forged event can no longer
	// invent a fingerprint that was never real.
	// Every config this run could legitimately have been assessed under: its own
	// recorded fingerprint, and both candidates a resolve produces now - the
	// second of which exists only on the degraded path, where assessRun judges
	// under both and records whichever was stricter (see src/app/assessRun.ts).
	// Omitting it would refuse to heal a genuine record written on that path.
	const currentResolve = await resolveRunConfig(repoRoot, run);
	const acceptableFingerprints = new Set(
		[
			run.configFingerprint,
			fingerprintOf(currentResolve.config),
			currentResolve.alsoAssessUnder === null ? null : fingerprintOf(currentResolve.alsoAssessUnder),
		].filter((value): value is string => value !== null),
	);
	if (!acceptableFingerprints.has(approval.configFingerprint)) {
		throw new Error(
			`run ${runId}'s recorded event's config fingerprint matches neither this run's own recorded fingerprint nor what resolving its config now produces; refusing to heal from it`,
		);
	}

	if (decision === "approved" && decide(verdict.name, approval.level) === "block") {
		throw new Error(`run ${runId}'s recorded event claims CRITICAL risk; refusing to heal it as an approval`);
	}

	await requireTypedConfirmation(runId, decision, verdict.name, approval.level);

	await writeApproval(rptDir, approval);
	await upsertRun(rptDir, { id: runId, task: run.task, state: outcomeState, startedAt: run.startedAt, endedAt: run.endedAt });
	return approval;
}

async function approvalFromRecordedEvent(rptDir: string, runId: RunId, decision: ApprovalDecision, verdict: Verdict): Promise<Approval> {
	const { events } = await readEvents(rptDir, runId);
	const kind = decision === "approved" ? "ApprovalGranted" : "ApprovalDenied";
	const recorded = events.find((event) => event.kind === kind);
	if (recorded === undefined) {
		throw new Error(`run ${runId} appears already ${decision} but no ${kind} event could be found to heal from`);
	}
	return approvalFromEventPayload(runId, decision, recorded, verdict);
}

function approvalFromEventPayload(runId: RunId, decision: ApprovalDecision, event: AgentEvent, verdict: Verdict): Approval {
	const by = typeof event.payload.by === "string" ? event.payload.by : null;
	const level = riskLevelOf(event.payload.level);
	const score = validScoreOf(event.payload.score);
	// A genuine assessment always contributes at least one of "tests-passed"
	// or "tests-unknown-or-failing" (risk/rules.ts): those two are mutually
	// exhaustive over testResult's three possible values, so an empty
	// contributions array is not a thin real assessment, it is one the
	// recorder could never have produced.
	const contributions = riskContributionsOf(event.payload.contributions);
	const configFingerprint = validFingerprintFormatOf(event.payload.configFingerprint);
	if (
		by === null ||
		!isValidApproverName(by) ||
		level === null ||
		score === null ||
		contributions === null ||
		contributions.length === 0 ||
		configFingerprint === null ||
		!isValidTimestamp(event.ts)
	) {
		throw new Error(`run ${runId} has a recorded ${event.kind} event whose payload cannot be healed from`);
	}
	// A forged event could name a different run's verdict, or one this run
	// was never actually decided against - the same class of mistake the
	// verdict-file runId binding closes for a file read directly off disk.
	if (event.payload.verdictName !== verdict.name) {
		throw new Error(
			`run ${runId}'s recorded ${event.kind} event names verdict ${String(event.payload.verdictName)}, but the verdict on disk is ${verdict.name}`,
		);
	}
	return {
		runId,
		decision,
		by,
		at: event.ts,
		// Derived from the verdict on disk, not copied from the event's own
		// override claim: a forged event could claim override: false for a
		// run that was never VERIFIED, and nothing before this read the
		// verdict to check it against. The same rule readApproval enforces
		// on every read now also holds at the moment a healed record is
		// written, rather than trusting a claim no reader ever honours.
		override: verdict.name !== "VERIFIED",
		level,
		score,
		contributions,
		configFingerprint,
	};
}

// Matches exactly what `new Date().toISOString()` produces - every
// timestamp in this codebase, including the one on the event being healed
// from, is written that way. A malformed or forged timestamp (a literal
// newline appended, for instance) round-trips to a different string here,
// same as it fails store/approvals.ts's own z.string().datetime() schema -
// caught before it can ever be written to a file that check would then
// refuse to read back.
function isValidTimestamp(value: string): boolean {
	const date = new Date(value);
	return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function riskLevelOf(value: unknown): RiskLevel | null {
	return (RISK_LEVELS as readonly unknown[]).includes(value) ? (value as RiskLevel) : null;
}

// assessRisk (risk/assess.ts) always clamps to [0, 100]; a real score can
// never fall outside that range.
function validScoreOf(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

// A real configFingerprint is always a sha256 hex digest (fingerprintOf,
// domain/checksum.ts) - 64 lowercase hex characters, never an arbitrary
// string. Format alone does not prove it is *this run's* real fingerprint
// (see healApproval's separate match check against the run's recorded
// fingerprint or a current resolve), but it rules out the cheap forgery of
// just writing any string in its place.
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
function validFingerprintFormatOf(value: unknown): string | null {
	return typeof value === "string" && FINGERPRINT_RE.test(value) ? value : null;
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

// A known agent marker is an absolute veto: no confirmation excuses it.
// "unknown" is deliberately allowed past this check (see the comment on
// AgentContextSignal above) - it falls through to record()'s mandatory
// typed confirmation, which is the actual, unconditional proof a human is
// present, rather than being refused before ever getting the chance to
// provide it.
function assertHuman(actor: Actor): void {
	if (actor.agentContext === "agent") {
		throw new Error("approval must come from a human, and this process is running inside a known agent context");
	}
	if (!actor.interactive) {
		throw new Error("approval requires an interactive terminal");
	}
}
