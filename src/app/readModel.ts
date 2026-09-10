import type { Approval } from "../domain/approval.js";
import type { AgentEvent, RunId } from "../domain/events.js";
import type { RiskLevel } from "../domain/policy.js";
import type { AgentRun } from "../domain/run.js";
import type { RunState } from "../domain/state.js";
import type { Verdict } from "../domain/verdict.js";
import { diffPatch } from "../git/diff.js";
import { runCost } from "../pricing/cost.js";
import { loadPricing } from "../pricing/table.js";
import type { RiskAssessment } from "../risk/assess.js";
import { readEvents } from "../store/eventLog.js";
import { rptDirOf } from "../store/paths.js";
import { listRuns, type RunIndexEntry } from "../store/runIndex.js";
import { readApproval } from "./approveRun.js";
import { assessRun } from "./assessRun.js";
import { loadRun } from "./loadRun.js";
import { readVerdict } from "./verifyRun.js";

export type RunSummary = {
	id: RunId;
	task: string;
	state: RunState;
	startedAt: string;
	endedAt: string | null;
	riskScore: number | null;
	riskLevel: RiskLevel | null;
	costUsd: number | null;
	// Why this row could not be projected from its event log, when it could
	// not. A damaged or still-starting run is listed with what the index knows
	// and the reason it knows no more - never dropped from the list, and never
	// shown as though it were an ordinary run with nothing to report.
	unprojectable: string | null;
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

// The read model is the whole of the boundary between the engine and any
// surface drawn on top of it. Everything it returns is a primitive, an array
// or a plain object, so a screen can render it, a test can snapshot it and a
// later web UI can be handed it over a wire with nothing in src/app changing.
export async function dashboardModel(repoRoot: string): Promise<DashboardModel> {
	const entries = await listRuns(rptDirOf(repoRoot));
	return { runs: await Promise.all(entries.map((entry) => summarise(repoRoot, entry))) };
}

export async function runDetailModel(repoRoot: string, runId: RunId): Promise<RunDetailModel> {
	const run = await loadRun(repoRoot, runId);
	const verdict = await readVerdict(repoRoot, runId);
	const cost = runCost(run.usage, await loadPricing(rptDirOf(repoRoot)));
	return {
		run,
		verdict,
		risk: verdict === null ? null : (await assessRun(repoRoot, run, verdict)).assessment,
		approval: await readApproval(repoRoot, runId),
		events: (await readEvents(rptDirOf(repoRoot), runId)).events,
		costUsd: cost.usd,
		unpricedModels: cost.unpriced,
	};
}

// The observed diff, reached through the read model rather than by a screen
// calling git itself: the console is a presentation shell over plain data, and
// the moment a component knows how to invoke git it stops being replaceable.
export async function runDiff(repoRoot: string, runId: RunId): Promise<string> {
	const run = await loadRun(repoRoot, runId);
	if (run.baseSha === null || run.endSha === null) return "";
	return diffPatch(repoRoot, run.baseSha, run.endSha);
}

// One unreadable run must not blank the whole dashboard. The failure is
// reported on the row it belongs to rather than thrown, because the list is
// the surface a user goes to precisely when something has gone wrong, and a
// list that refuses to render is the silence this tool exists to remove.
async function summarise(repoRoot: string, entry: RunIndexEntry): Promise<RunSummary> {
	try {
		const detail = await runDetailModel(repoRoot, entry.id);
		return {
			id: detail.run.id,
			task: detail.run.task,
			state: entry.state,
			startedAt: detail.run.startedAt,
			endedAt: detail.run.endedAt,
			riskScore: detail.risk?.score ?? null,
			riskLevel: detail.risk?.level ?? null,
			costUsd: detail.costUsd,
			unprojectable: null,
		};
	} catch (error) {
		return {
			id: entry.id,
			task: entry.task,
			state: entry.state,
			startedAt: entry.startedAt,
			endedAt: entry.endedAt,
			riskScore: null,
			riskLevel: null,
			costUsd: null,
			unprojectable: error instanceof Error ? error.message : String(error),
		};
	}
}
