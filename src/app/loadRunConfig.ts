import { DEFAULT_CONFIG, loadConfig } from "../config/load.js";
import type { RptConfig } from "../config/schema.js";
import { fingerprintOf } from "../domain/checksum.js";
import type { AgentRun } from "../domain/run.js";
import { readRunConfig } from "../store/runConfig.js";
import { rptDirOf } from "../store/paths.js";

export type ResolvedRunConfig = {
	config: RptConfig;
	// The repository's live config, on the degraded path only, when it could be
	// read at all. A run whose snapshot failed verification must be assessed
	// under both this and `config` above, and judged by whichever result is
	// stricter - see src/app/assessRun.ts. Null whenever there is nothing to
	// compare against, which is every non-degraded path.
	alsoAssessUnder: RptConfig | null;
	configChangedSinceSnapshot: boolean;
};

// The config both verification and approval must assess a run against: the
// snapshot taken at that run's start, not a live read of rpt.config.json -
// which the run itself, or anything else with repository write access, can
// still edit for the rest of its own evaluation.
//
// A missing snapshot is not trusted at face value as "this run predates the
// feature": that read exactly the same as an attacker deleting the snapshot
// file to silently fall back to a live read - which, left unchecked, would
// also have silenced the drift finding designed to expose exactly that
// tampering, since the fallback and the "live" side of the comparison would
// then be the same read. run.configFingerprint (recorded in RunStarted
// itself, immune to anything happening to the snapshot file afterward) is
// the tiebreaker: null means this run genuinely predates the feature, in
// which case there is nothing to compare against and no drift claim is
// made; a non-null value with no matching, fingerprint-verified snapshot on
// disk means the snapshot cannot be trusted, and configChangedSinceSnapshot
// is forced true rather than silently unset.
//
// The alarm alone was not enough: welding the drift finding on while still
// falling back to a live read on that same path left the protection off -
// whoever deleted or altered the snapshot still got to choose the live
// rpt.config.json their own run is scored against, and the typed
// confirmation would then read the human a level derived from the
// attacker's own file. On this path the config used is DEFAULT_CONFIG -
// rpt's own shipped defaults, never the repository's file - so tampering
// with the snapshot cannot also choose what the run is judged against; it
// can only ever make the judgement stricter than a project's own configured
// thresholds, and the drift finding still fires so the substitution is
// visible. Restoring the real snapshot (or a fresh run, which snapshots
// again) recovers the real config immediately - this is a degradation, not
// a refusal, exactly because DEFAULT_CONFIG is always available with no I/O
// that could itself fail.
//
// "Never the repository's file" was directionally right and absolutely wrong,
// and this is the correction. A project's own config may be STRICTER than
// rpt's defaults: for any repository that sets a block threshold below
// fifty-one, substituting DEFAULT_CONFIG on the degraded path moves a run from
// critical to approvable, and the typed confirmation then reads the human the
// downgraded level, so they approve honestly on a false premise. Deleting one
// file inside .rpt was enough to do it.
//
// The rule is not "never the repository's file", it is "never the laxer of the
// two". Both configs come back from this function on that path, and
// src/app/assessRun.ts assesses under each and takes the stricter result. The
// defaults remove the attacker-relaxed direction, the live config removes the
// project-relaxed direction, and an attacker who edits the live config to be
// stricter only ever blocks an approval. The cost, when this is wrong, is that
// a run is judged more strictly than either config alone would judge it - on a
// path that already forces a visible drift finding.
//
// Never throws: a snapshot that is missing, unreadable, or fails its own
// schema is handled the same way as one that fails its fingerprint check.
// A run that genuinely predates the feature (configFingerprint === null)
// is a different case with nothing to verify - that one still falls back to
// a live read, since there is no tampering to defend against and no
// snapshot the run was ever judged by.
export async function resolveRunConfig(repoRoot: string, run: AgentRun): Promise<ResolvedRunConfig> {
	const snapshot = await readSnapshotOrNull(rptDirOf(repoRoot), run.id);

	if (run.configFingerprint === null) {
		return { config: await loadConfigOrDefault(repoRoot), alsoAssessUnder: null, configChangedSinceSnapshot: false };
	}

	if (snapshot === null || fingerprintOf(snapshot) !== run.configFingerprint) {
		return { config: DEFAULT_CONFIG, alsoAssessUnder: await loadConfigSafely(repoRoot), configChangedSinceSnapshot: true };
	}

	const live = await loadConfigSafely(repoRoot);
	const configChangedSinceSnapshot = live === null || JSON.stringify(live) !== JSON.stringify(snapshot);
	return { config: snapshot, alsoAssessUnder: null, configChangedSinceSnapshot };
}

async function readSnapshotOrNull(rptDir: string, runId: number): Promise<RptConfig | null> {
	try {
		return await readRunConfig(rptDir, runId);
	} catch {
		return null;
	}
}

async function loadConfigSafely(repoRoot: string): Promise<RptConfig | null> {
	try {
		return await loadConfig(repoRoot);
	} catch {
		return null;
	}
}

async function loadConfigOrDefault(repoRoot: string): Promise<RptConfig> {
	return (await loadConfigSafely(repoRoot)) ?? DEFAULT_CONFIG;
}
