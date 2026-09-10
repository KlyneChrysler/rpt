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

// The load-bearing check of the whole project: an agent cannot clear its own
// run. Two independent conditions, both required - a terminal check alone is
// defeated by an agent that has one; an agent-context check alone is defeated
// by an agent whose environment does not advertise itself. Order matters only
// for which message a caller sees; either failing refuses the approval.
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
