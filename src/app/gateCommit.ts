import type { RunId } from "../domain/events.js";
import { decide } from "../domain/policy.js";
import type { AgentRun } from "../domain/run.js";
import type { Verdict } from "../domain/verdict.js";
import type { RiskAssessment } from "../risk/assess.js";
import { appendEvent } from "../store/eventLog.js";
import { rptDirOf } from "../store/paths.js";
import { activeRun } from "../store/runIndex.js";
import { readApproval } from "./approveRun.js";
import { assessRun } from "./assessRun.js";
import { loadRun } from "./loadRun.js";
import { readVerdict, verifyRun } from "./verifyRun.js";

export type GateOutcome = { allowed: boolean; exitCode: number; message: string };

const ALLOWED: GateOutcome = { allowed: true, exitCode: 0, message: "" };

// The pre-commit gate. Its exit code is the contract: zero lets the commit
// proceed, one stops it. A repository with no run awaiting adjudication is
// answered zero and nothing else - rpt must never stand between a person and
// a commit they made by hand.
export async function gateCommit(repoRoot: string): Promise<GateOutcome> {
	const entry = await activeRun(rptDirOf(repoRoot));
	if (entry === null) return ALLOWED;

	const verdict = (await readVerdict(repoRoot, entry.id)) ?? (await verifyRun(repoRoot, entry.id));
	// Loaded after verification, not before: verifyRun appends events and moves
	// the run's state, so a projection taken beforehand is stale by the time the
	// assessment reads it.
	const run = await loadRun(repoRoot, entry.id);
	const { assessment } = await assessRun(repoRoot, run, verdict);

	const judgement = await judge(repoRoot, run, verdict, assessment);
	await recordGateEvent(repoRoot, run.id, assessment, judgement);
	return judgement.outcome;
}

type Judgement = { outcome: GateOutcome; bypassed: boolean };

async function judge(repoRoot: string, run: AgentRun, verdict: Verdict, risk: RiskAssessment): Promise<Judgement> {
	const decision = decide(verdict.name, risk.level);
	if (decision === "auto" || decision === "review") return { outcome: ALLOWED, bypassed: false };

	// Checked ahead of the bypass, and it must stay ahead of it: CRITICAL has no
	// approval path at all, so an environment variable must not become one.
	if (decision === "block") {
		return refuse(run, verdict, risk, "risk level CRITICAL cannot be approved - the change must be reduced");
	}

	const approval = await readApproval(repoRoot, run.id);
	if (approval?.decision === "approved") return { outcome: ALLOWED, bypassed: false };
	if (bypassRequested()) return { outcome: ALLOWED, bypassed: true };
	if (approval?.decision === "rejected") return refuse(run, verdict, risk, "this run was rejected by a human");
	return refuse(run, verdict, risk, `approve with:  rpt approve ${run.id}`);
}

function refuse(run: AgentRun, verdict: Verdict, risk: RiskAssessment, remedy: string): Judgement {
	return { outcome: blocked(run, verdict, risk, remedy), bypassed: false };
}

function blocked(run: AgentRun, verdict: Verdict, risk: RiskAssessment, remedy: string): GateOutcome {
	return {
		allowed: false,
		exitCode: 1,
		message: [
			"rpt: commit blocked",
			"",
			`  run ${run.id}  ${run.task}`,
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

// ApprovalRequested for every outcome, allowed or blocked, and never
// ApprovalGranted/ApprovalDenied: those two are decision events the run
// projection folds into a state transition, so recording a gate result under
// one of them would either move the run to REJECTED behind the human's back
// or - lacking the verdictName such an event must carry - gap the log and
// permanently disqualify the run from VERIFIED. The gate observes; it does
// not decide. What the payload carries is the score at the time and whether
// a bypass was used, so a bypassed commit is visible in the record rather
// than indistinguishable from a clean one.
async function recordGateEvent(repoRoot: string, runId: RunId, risk: RiskAssessment, judgement: Judgement): Promise<void> {
	await appendEvent(rptDirOf(repoRoot), runId, {
		ts: new Date().toISOString(),
		source: "rpt",
		kind: "ApprovalRequested",
		payload: {
			score: risk.score,
			level: risk.level,
			allowed: judgement.outcome.allowed,
			// The flag says the bypass is what allowed this commit, not merely
			// that the variable happened to be set: a run a human had already
			// approved is not a bypassed run, and recording it as one would put
			// a false claim in the one place the record exists to be true.
			bypass: judgement.bypassed,
		},
	});
}
