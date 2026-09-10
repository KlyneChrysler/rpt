import { exec } from "node:child_process";
import { access, lstat, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { diffNameStatus, diffPatch } from "../git/diff.js";
import { scanSecrets, type SecretFinding } from "./scanSecrets.js";
import { failed, passed, type RunContext, type Verifier, type VerifierResult } from "./Verifier.js";

const run = promisify(exec);
const AUDIT_TIMEOUT_MS = 90 * 1000;

type AuditOutcome = "clean" | "findings" | "skipped" | "not-applicable";
type AuditResult = { outcome: AuditOutcome; reason: string | null };

export const securityVerifier: Verifier = {
	id: "security",
	async run(context: RunContext): Promise<VerifierResult> {
		const patch = await diffPatch(context.repoRoot, context.baseSha, context.endSha);
		const secretFindings = scanSecrets(patch);
		const audit = await auditIfManifestChanged(context);
		const facts = { secretFindings, audit: audit.outcome };

		if (secretFindings.length > 0) {
			return failed("security", `${secretFindings.length} possible secret(s): ${describe(secretFindings)}`, facts);
		}
		if (audit.outcome === "findings") {
			return failed("security", audit.reason ?? "dependency audit reported high severity findings", facts);
		}
		return passed("security", facts);
	},
};

// The reason names the rule and the file/line, never the matched text - printing
// a discovered credential into a log, a note or a terminal would spread the
// exposure this verifier exists to catch.
function describe(findings: readonly SecretFinding[]): string {
	return findings.map((finding) => `${finding.rule} at ${finding.path}:${finding.line}`).join(", ");
}

const AUDIT_MANIFESTS = ["package.json", "package-lock.json"];

async function auditIfManifestChanged(context: RunContext): Promise<AuditResult> {
	const entries = await diffNameStatus(context.repoRoot, context.baseSha, context.endSha);
	const changed = entries.some((entry) => AUDIT_MANIFESTS.includes(basename(entry.path)));
	if (!changed) return { outcome: "not-applicable", reason: null };

	const environment = await prepareAuditEnvironment(context.repoRoot, context.worktree);
	if (!environment.ready) return { outcome: "skipped", reason: environment.reason };

	try {
		return await runAudit(context.worktree);
	} finally {
		// Scope the write-through window to this audit, not the worktree's whole
		// lifetime, the same way TestVerifier scopes its own node_modules link -
		// leaving it in place would let a later, unrelated use of this worktree
		// mutate the user's real dependency directory.
		if (environment.linkedPath !== null) await rm(environment.linkedPath, { force: true }).catch(() => {});
	}
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

type Environment = { ready: true; linkedPath: string | null } | { ready: false; reason: string };

// npm audit only needs a lockfile to consult, not an installed tree - unlike
// TestVerifier's suite run, which cannot resolve a single import without one.
// So a missing repoRoot/node_modules is not itself a reason to skip here; it is
// only linked in, scoped to this audit, when it happens to be available, as a
// hedge against npm versions that also consult the installed tree.
async function prepareAuditEnvironment(repoRoot: string, worktree: string): Promise<Environment> {
	if (!(await exists(join(worktree, "package-lock.json")))) {
		return {
			ready: false,
			reason: "no package-lock.json in the worktree; npm audit requires an existing lockfile",
		};
	}

	const target = join(worktree, "node_modules");
	const entry = await inspectEntry(target);
	if (entry === "usable") return { ready: true, linkedPath: null };
	if (entry === "broken-link") await rm(target, { force: true });

	const source = join(repoRoot, "node_modules");
	if (!(await exists(source))) return { ready: true, linkedPath: null };

	await symlink(source, target, "dir");
	return { ready: true, linkedPath: target };
}

async function inspectEntry(path: string): Promise<"absent" | "usable" | "broken-link"> {
	let entryStat;
	try {
		entryStat = await lstat(path);
	} catch {
		return "absent";
	}
	if (!entryStat.isSymbolicLink()) return "usable";
	try {
		await stat(path); // follows the link; throws if the target is gone
		return "usable";
	} catch {
		return "broken-link";
	}
}

type AuditReport = { vulnerabilities?: Record<string, unknown> };
type AuditFailure = { code?: number | string; killed?: boolean; stdout?: string; message: string };

async function runAudit(worktree: string): Promise<AuditResult> {
	try {
		const { stdout } = await run("npm audit --audit-level=high --json", {
			cwd: worktree,
			timeout: AUDIT_TIMEOUT_MS,
		});
		return classify(stdout);
	} catch (error) {
		const failure = error as AuditFailure;
		// npm exits non-zero both when it finds high severity advisories and when
		// it fails to run at all (no network, a stale lockfile) - the two are
		// indistinguishable by exit code alone. What tells them apart is whether
		// npm ever produced its own audit report: a report with a top-level
		// "error" key, or no parseable JSON at all, means npm never really started
		// the audit; a report with a "vulnerabilities" key means it did, and the
		// findings are real evidence.
		if (typeof failure.stdout === "string" && failure.stdout.trim() !== "") {
			const outcome = classify(failure.stdout);
			if (outcome.outcome !== "skipped") return outcome;
		}
		return { outcome: "skipped", reason: environmentalReason(failure) };
	}
}

function classify(stdout: string): AuditResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return { outcome: "skipped", reason: "npm audit did not produce parseable output" };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { outcome: "skipped", reason: "npm audit output was not a JSON object" };
	}

	const record = parsed as Record<string, unknown>;
	if ("error" in record) {
		const auditError = record.error as { code?: string; summary?: string } | undefined;
		const detail = auditError?.code ?? auditError?.summary ?? "unknown error";
		return { outcome: "skipped", reason: `npm audit could not run: ${detail}` };
	}

	const report = record as AuditReport;
	const vulnerabilityCount = Object.keys(report.vulnerabilities ?? {}).length;
	if (vulnerabilityCount > 0) {
		return { outcome: "findings", reason: "dependency audit reported high severity findings" };
	}
	return { outcome: "clean", reason: null };
}

function environmentalReason(failure: AuditFailure): string {
	if (failure.killed) {
		return `npm audit was killed after exceeding rpt's timeout deadline of ${AUDIT_TIMEOUT_MS}ms; rpt did not observe an audit result for this run`;
	}
	if (failure.code === 127) {
		return "npm is not available on PATH; rpt could not run a dependency audit for this run";
	}
	return `npm audit failed to run: ${firstLine(failure.message)}`;
}

function firstLine(message: string): string {
	return message.split("\n")[0] ?? message;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
