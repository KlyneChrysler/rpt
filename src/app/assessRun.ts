import type { RptConfig } from "../config/schema.js";
import type { AgentRun } from "../domain/run.js";
import type { Verdict } from "../domain/verdict.js";
import { assessRisk, type RiskAssessment } from "../risk/assess.js";
import { buildFacts, type RunFacts } from "../risk/facts.js";
import { resolveRunConfig } from "./loadRunConfig.js";

export type RunAssessment = {
	assessment: RiskAssessment;
	// The observations the score was computed from, returned alongside it so a
	// caller that needs a fact the assessment already derived - the observed
	// file count in the attestation, say - reads the same numbers the score
	// used rather than re-deriving them from the agent's claims.
	facts: RunFacts;
	config: RptConfig;
	configChangedSinceSnapshot: boolean;
};

// The one way a run's risk is computed, shared by approval, the commit gate,
// the attestation and the read model. Three callers each resolving the config
// and building the facts themselves is how the gate comes to block at a level
// the approval prompt never showed the human - the two would be reading
// different configs, or passing the drift flag in one place and not the
// other, with nothing making that visible.
export async function assessRun(repoRoot: string, run: AgentRun, verdict: Verdict): Promise<RunAssessment> {
	const { config, configChangedSinceSnapshot } = await resolveRunConfig(repoRoot, run);
	const facts = buildFacts(verdict.results, config, configChangedSinceSnapshot);
	return { assessment: assessRisk(facts, config), facts, config, configChangedSinceSnapshot };
}
