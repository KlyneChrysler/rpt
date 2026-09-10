import type { Approval } from "../domain/approval.js";
import { fingerprintOf } from "../domain/checksum.js";
import type { RunId } from "../domain/events.js";
import type { AgentRun } from "../domain/run.js";
import type { Verdict } from "../domain/verdict.js";
import { git } from "../git/exec.js";
import { runCost } from "../pricing/cost.js";
import { loadPricing } from "../pricing/table.js";
import type { RiskAssessment } from "../risk/assess.js";
import { appendEvent, readEvents } from "../store/eventLog.js";
import { rptDirOf } from "../store/paths.js";
import { activeRun, upsertRun } from "../store/runIndex.js";
import { readApproval } from "./approveRun.js";
import { assessRun } from "./assessRun.js";
import { loadRun } from "./loadRun.js";
import { readVerdict } from "./verifyRun.js";

const NOTES_REF = "refs/notes/rpt";

// Attaches the attestation to the commit that just landed and moves the run to
// RECORDED. Runs from post-commit, where the commit already exists, so every
// path that cannot produce a note returns null rather than throwing: there is
// nothing a failure here can undo, and a post-commit hook that errors only
// alarms a user who can do nothing about it.
export async function recordCommit(repoRoot: string): Promise<string | null> {
	const entry = await activeRun(rptDirOf(repoRoot));
	if (entry === null) return null;

	const verdict = await readVerdict(repoRoot, entry.id);
	if (verdict === null) return null;

	const run = await loadRun(repoRoot, entry.id);
	const note = await attestationFor(repoRoot, run, verdict);
	await git(repoRoot, ["notes", `--ref=${NOTES_REF}`, "add", "-f", "-m", note, "HEAD"]);

	await appendEvent(rptDirOf(repoRoot), run.id, {
		ts: new Date().toISOString(),
		source: "rpt",
		kind: "RunCommitted",
		payload: { commit: await git(repoRoot, ["rev-parse", "HEAD"]), verdictName: verdict.name },
	});
	await upsertRun(rptDirOf(repoRoot), {
		id: run.id,
		task: run.task,
		state: "RECORDED",
		startedAt: run.startedAt,
		endedAt: run.endedAt,
	});
	return note;
}

// The note travels with the repository and is reviewable in a pull request, so
// every line here has to be true without the .rpt directory to check it
// against - and has to say plainly when a number is not known, rather than
// printing a zero that reads as a measurement.
export async function attestationFor(repoRoot: string, run: AgentRun, verdict: Verdict): Promise<string> {
	const { assessment, facts } = await assessRun(repoRoot, run, verdict);
	const cost = runCost(run.usage, await loadPricing(rptDirOf(repoRoot)));
	const tests = verdict.results.find((result) => result.id === "tests")?.facts ?? {};
	return [
		`run ${run.id} | ${run.task}`,
		verdictLine(verdict, assessment),
		`tests ${countText(tests.passed)} passed ${countText(tests.failed)} failed | files ${facts.fileCount} | ${costLine(cost.usd)}`,
		approvalLine(await readApproval(repoRoot, run.id), verdict),
		`digest ${await digestOf(repoRoot, run.id)}`,
		"",
	].join("\n");
}

function verdictLine(verdict: Verdict, risk: RiskAssessment): string {
	return `verdict ${verdict.name} | risk ${risk.score} ${risk.level}`;
}

// A missing count is "unknown", never zero: a reporter rpt could not parse and
// a suite with no failures produce the same number otherwise, and only one of
// them is evidence of anything.
function countText(value: unknown): string {
	return typeof value === "number" && Number.isFinite(value) ? String(value) : "unknown";
}

function costLine(usd: number | null): string {
	return usd === null ? "cost unknown" : `cost ${usd.toFixed(2)} USD`;
}

// Three outcomes that must stay distinguishable in the record: a run that
// needed no human at all, a run a human cleared after rpt verified it, and a
// run a human signed off on despite rpt being unable to verify it.
function approvalLine(approval: Approval | null, verdict: Verdict): string {
	if (approval === null) return "cleared automatically";
	if (approval.decision === "rejected") return `rejected by ${approval.by} at ${approval.at}`;
	const verb = approval.override ? `approved despite ${verdict.name}` : "approved";
	return `${verb} by ${approval.by} at ${approval.at}`;
}

// Over the events as read back, which is the same view any later check has:
// readEvents strips each line's checksum, so the digest is reproducible from
// the log rather than from a private in-memory shape.
async function digestOf(repoRoot: string, runId: RunId): Promise<string> {
	const { events } = await readEvents(rptDirOf(repoRoot), runId);
	return `sha256:${fingerprintOf(events).slice(0, 16)}`;
}
