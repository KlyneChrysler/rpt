import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../config/load.js";
import { isValidApproverName, type Approval, type ApprovalDecision } from "../domain/approval.js";
import type { RunId } from "../domain/events.js";
import { decide } from "../domain/policy.js";
import { applyApprovalDecision } from "../domain/run.js";
import { assessRisk } from "../risk/assess.js";
import { buildFacts } from "../risk/facts.js";
import { appendEvent } from "../store/eventLog.js";
import { readApproval as readApprovalRecord, writeApproval } from "../store/approvals.js";
import { rptDirOf } from "../store/paths.js";
import { upsertRun } from "../store/runIndex.js";
import { loadRun } from "./loadRun.js";
import { readVerdict } from "./verifyRun.js";

// "agent": a known marker was found - an absolute refusal, no confirmation
// can override it. "unknown": no marker was found, which is not the same as
// proof no agent is present - the brief demanded refusal on uncertainty, and
// treating a silent environment as a human was exactly the gap that let one
// through. "human": positively established - today, the only way there is a
// typed confirmation read from the controlling terminal (see
// actorFromEnvironment below); nothing in this module infers it from absence.
export type AgentContextSignal = "agent" | "human" | "unknown";

export type Actor = { name: string; interactive: boolean; agentContext: AgentContextSignal };

const CONTROLLING_TERMINAL_DEVICE = "/dev/tty";
const CONFIRMATION_TOKEN = "yes";
const CONFIRMATION_PROMPT = "rpt: type 'yes' at this terminal to confirm a human is recording this decision: ";

export async function actorFromEnvironment(): Promise<Actor> {
	const name = process.env.USER ?? process.env.LOGNAME ?? "unknown";
	const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
	if (knownAgentMarkerPresent()) {
		return { name, interactive, agentContext: "agent" };
	}
	const humanConfirmed = await confirmedAtControllingTerminal();
	return { name, interactive, agentContext: humanConfirmed ? "human" : "unknown" };
}

function knownAgentMarkerPresent(): boolean {
	return process.env.RPT_AGENT_CONTEXT === "1" || process.env.CLAUDECODE === "1";
}

// Reads from the controlling terminal device, not standard input, so a typed
// answer survives stdin/stdout being redirected or piped - the exact gap an
// automated bypass exploits by attaching a pseudo-terminal that satisfies the
// isTTY checks without a human ever being asked anything. This converts the
// check from "this process has a terminal" to "a human typed something at
// it", which defeats a bypass that is not actively impersonating a person -
// it does not, and cannot, defend against one that is: see README.
async function confirmedAtControllingTerminal(): Promise<boolean> {
	let typed: string;
	try {
		typed = await readLineFromControllingTerminal(CONFIRMATION_PROMPT);
	} catch {
		// No controlling terminal to ask - refuse rather than guess. This is
		// the failure mode the brief asked for: unable to determine, so no.
		return false;
	}
	return isConfirmed(typed);
}

export function isConfirmed(typed: string): boolean {
	return typed.trim() === CONFIRMATION_TOKEN;
}

async function readLineFromControllingTerminal(prompt: string): Promise<string> {
	const input = createReadStream(CONTROLLING_TERMINAL_DEVICE);
	const output = createWriteStream(CONTROLLING_TERMINAL_DEVICE);
	await Promise.all([once(input, "open"), once(output, "open")]);
	const rl = createInterface({ input, output, terminal: true });
	try {
		return await rl.question(prompt);
	} finally {
		rl.close();
		input.destroy();
		output.destroy();
	}
}

export function approveRun(repoRoot: string, runId: RunId, actor: Actor): Promise<Approval> {
	return record(repoRoot, runId, actor, "approved");
}

export function rejectRun(repoRoot: string, runId: RunId, actor: Actor): Promise<Approval> {
	return record(repoRoot, runId, actor, "rejected");
}

// The load-bearing read of the whole project: override is never trusted from
// disk. A hand-edited approval.json could claim override: false for a run
// that was never VERIFIED; re-deriving it from the verdict on every read,
// rather than returning whatever the file says, keeps there being one source
// of truth for that claim instead of two copies with nothing binding them.
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
		throw new Error("approver name is empty, longer than 200 characters, or contains a control character");
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
	// whose event append succeeded and whose file write did not. Retrying
	// completes that write instead of either re-appending a second event
	// (which projectRun's reducer would reject as an illegal replay) or
	// refusing a retry that has every right to succeed.
	const outcomeState = decision === "approved" ? "APPROVED" : "REJECTED";
	const healing = run.state === outcomeState;
	if (!healing) {
		// Throws (IllegalTransitionError, via applyApprovalDecision) for a run
		// this decision cannot legally apply to: never verified, already
		// decided the other way, or already recorded - a state precondition
		// enforced by the same transition graph the projection itself uses,
		// not by approval.json's mere presence or absence.
		applyApprovalDecision(run.state, verdict.name, decision);
	}

	const config = await loadConfig(repoRoot);
	const { level } = assessRisk(buildFacts(verdict.results, config), config);
	if (decision === "approved" && decide(verdict.name, level) === "block") {
		throw new Error(`run ${runId} is CRITICAL risk and cannot be approved - the change must be reduced, not signed off`);
	}

	const approval: Approval = {
		runId,
		decision,
		by: actor.name,
		at: new Date().toISOString(),
		override: verdict.name !== "VERIFIED",
		level,
	};

	// The event log is the source of truth, so it is written first: if this
	// fails, nothing else has happened yet and a retry starts clean. If it
	// succeeds but the file write below does not, the run is left exactly in
	// the "healing" state handled above, not in an unrecoverable one.
	if (!healing) {
		await appendEvent(rptDir, runId, {
			ts: approval.at,
			source: "rpt",
			kind: decision === "approved" ? "ApprovalGranted" : "ApprovalDenied",
			payload: { by: approval.by, override: approval.override, level, verdictName: verdict.name },
		});
	}
	await writeApproval(rptDir, approval);
	await upsertRun(rptDir, { id: runId, task: run.task, state: outcomeState, startedAt: run.startedAt, endedAt: run.endedAt });
	return approval;
}

// Two independent conditions, both required - a terminal check alone is
// defeated by an agent that has one; an agent-context check alone is
// defeated by an agent whose environment does not advertise itself.
// agentContext is now tri-state (see the type above): "unknown" refuses
// exactly like "agent" does, so a silent environment is never read as proof
// of a human.
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
