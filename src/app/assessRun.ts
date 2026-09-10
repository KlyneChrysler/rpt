import type { RptConfig } from "../config/schema.js";
import { fingerprintOf } from "../domain/checksum.js";
import { RISK_LEVELS } from "../domain/policy.js";
import type { AgentRun } from "../domain/run.js";
import type { Verdict } from "../domain/verdict.js";
import { assessRisk, type RiskAssessment } from "../risk/assess.js";
import { buildFacts, type RunFacts } from "../risk/facts.js";
import { appendEvent } from "../store/eventLog.js";
import { rptDirOf } from "../store/paths.js";
import { writeRiskAssessment } from "../store/risk.js";
import { resolveRunConfig } from "./loadRunConfig.js";

export type RunAssessment = {
	assessment: RiskAssessment;
	// The observations the score was computed from, returned alongside it so a
	// caller that needs a fact the assessment already derived - the observed
	// file count in the attestation, say - reads the same numbers the score
	// used rather than re-deriving them from the agent's claims.
	facts: RunFacts;
	// The config that produced the assessment above, which on the degraded path
	// is whichever candidate judged the run more strictly. Returned so a caller
	// recording the decision fingerprints the config the human was actually
	// shown a level from, rather than a different one that happened to be
	// resolved first.
	config: RptConfig;
	configChangedSinceSnapshot: boolean;
};

// The one way a run's risk is computed, shared by approval, the commit gate,
// the attestation and the read model. Three callers each resolving the config
// and building the facts themselves is how the gate comes to block at a level
// the approval prompt never showed the human - the two would be reading
// different configs, or passing the drift flag in one place and not the other,
// with nothing making that visible.
export async function assessRun(repoRoot: string, run: AgentRun, verdict: Verdict): Promise<RunAssessment> {
	const { config, alsoAssessUnder, configChangedSinceSnapshot } = await resolveRunConfig(repoRoot, run);
	const primary = under(config, verdict, configChangedSinceSnapshot);
	if (alsoAssessUnder === null) return { ...primary, configChangedSinceSnapshot };
	const alternate = under(alsoAssessUnder, verdict, configChangedSinceSnapshot);
	return { ...stricter(primary, alternate), configChangedSinceSnapshot };
}

type Assessed = { assessment: RiskAssessment; facts: RunFacts; config: RptConfig };

function under(config: RptConfig, verdict: Verdict, configChangedSinceSnapshot: boolean): Assessed {
	const facts = buildFacts(verdict.results, config, configChangedSinceSnapshot);
	return { assessment: assessRisk(facts, config), facts, config };
}

// Fails closed in both directions. Ranked by band first, because the band is
// what the gate and the confirmation phrase actually turn on, and by score only
// to break a tie within a band. Neither candidate is trusted to be the safe
// one: rpt's own defaults stop a tamperer relaxing a run's thresholds by
// deleting its snapshot, and the repository's own file stops the substitution
// relaxing a project that had configured itself more strictly than rpt ships.
function stricter(left: Assessed, right: Assessed): Assessed {
	const byLevel = severityOf(right) - severityOf(left);
	if (byLevel !== 0) return byLevel > 0 ? right : left;
	return right.assessment.score > left.assessment.score ? right : left;
}

function severityOf(assessed: Assessed): number {
	return RISK_LEVELS.indexOf(assessed.assessment.level);
}

// Assesses a run and writes the assessment down: one RiskAssessed event on the
// timeline, and risk.json beside the run's verdict. Called wherever a run is
// judged for a decision - when a verdict is produced, and again at the gate -
// never from a read path, because a command that renders a score must not
// change the record by being run.
//
// The file is a readable copy of a value the engine re-derives on every
// decision, never an input to one: nothing reads it back to gate or approve, so
// editing it cannot lower the level anybody is judged at. It carries the verdict
// name and the config fingerprint it came from, so a copy that has stopped
// describing its run says so rather than quietly disagreeing.
export async function assessAndRecord(repoRoot: string, run: AgentRun, verdict: Verdict): Promise<RunAssessment> {
	const result = await assessRun(repoRoot, run, verdict);
	const assessedAt = new Date().toISOString();
	await appendEvent(rptDirOf(repoRoot), run.id, {
		ts: assessedAt,
		source: "rpt",
		kind: "RiskAssessed",
		payload: {
			score: result.assessment.score,
			level: result.assessment.level,
			contributions: result.assessment.contributions,
		},
	});
	await writeRiskAssessment(rptDirOf(repoRoot), {
		...result.assessment,
		runId: run.id,
		verdictName: verdict.name,
		configFingerprint: fingerprintOf(result.config),
		assessedAt,
	});
	return result;
}
