import { loadConfig } from "../config/load.js";
import type { RptConfig } from "../config/schema.js";
import type { RunId } from "../domain/events.js";
import { readRunConfig } from "../store/runConfig.js";
import { rptDirOf } from "../store/paths.js";

// The config both verification and approval must assess a run against: the
// snapshot taken at that run's start, not a live read of rpt.config.json -
// which the run itself, or anything else with repository write access, can
// still edit for the rest of its own evaluation. A run started before this
// snapshot existed has none to read; falling back to a live read for that
// case only, rather than refusing outright, keeps a pre-existing run's
// verdict and approval history readable instead of newly broken by this
// change.
export async function loadRunConfig(repoRoot: string, runId: RunId): Promise<RptConfig> {
	const snapshot = await readRunConfig(rptDirOf(repoRoot), runId);
	return snapshot ?? loadConfig(repoRoot);
}
