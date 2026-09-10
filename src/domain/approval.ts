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
// Rejects every ASCII control character, including newline, carriage return
// and tab. The approver's name flows verbatim into a git note a later task
// writes and reviewers read; an unescaped newline in it forges an extra line
// of that note's own output.
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

export function isValidApproverName(name: string): boolean {
	return name.length > 0 && name.length <= APPROVER_NAME_MAX_LENGTH && !CONTROL_CHAR_RE.test(name);
}
