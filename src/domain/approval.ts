import type { RunId } from "./events.js";
import type { RiskLevel } from "./policy.js";

// Exists at runtime for the same reason RUN_STATES and RISK_LEVELS do: the
// store layer validates a decision read back from disk against a real value,
// not just a compile-time label.
export const APPROVAL_DECISIONS = ["approved", "rejected"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export type Approval = {
	runId: RunId;
	decision: ApprovalDecision;
	by: string;
	at: string;
	// True when the verdict being approved or rejected was not VERIFIED - a
	// failed or unverified run signed off on anyway. Always derived from the
	// verdict, never trusted as stored: see src/app/approveRun.ts's readApproval,
	// which re-derives this on every read rather than returning whatever a
	// hand-edited approval.json happens to claim.
	override: boolean;
	// The risk level the human was actually shown when they decided, persisted
	// so a later reader adjudicates against what was granted rather than
	// re-deriving a level from a config file that may have changed since.
	level: RiskLevel;
};

const APPROVER_NAME_MAX_LENGTH = 200;
// An allowlist, not a denylist: only Unicode letters, marks (for combining
// accents), numbers, punctuation, symbols, and a plain space are accepted.
// A denylist of ASCII control characters was tried first and missed several
// Unicode line terminators - U+2028 LINE SEPARATOR, U+2029 PARAGRAPH
// SEPARATOR, U+0085 NEXT LINE - none of which are ASCII control characters,
// all of which render as a line break in enough contexts (including the git
// note a later task writes from this record) to forge a line the same way a
// plain newline does. Excluding everything not explicitly listed closes that
// gap instead of chasing each new terminator individually.
const ALLOWED_NAME_RE = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u;

export function isValidApproverName(name: string): boolean {
	return name.length <= APPROVER_NAME_MAX_LENGTH && ALLOWED_NAME_RE.test(name);
}
