import type { Verdict } from "../domain/verdict.js";
import type { RiskAssessment } from "../risk/assess.js";
import type { OutputFormat } from "./format.js";

const BAR_WIDTH = 20;
const LABEL_WIDTH = 48;
const MAX_SCORE = 100;

// The agent format is injected into an agent's context on every invocation, so
// its size is a correctness property, not a nicety. The score, the level and
// the verdict are never truncated; the itemisation is, with a line saying how
// much was left out - silent truncation would be the tool quietly under-
// reporting the very thing it exists to report.
const AGENT_CONTRIBUTION_CAP = 6;

export function renderRisk(assessment: RiskAssessment, format: OutputFormat): string {
	if (format === "json") return JSON.stringify(assessment, null, 2);
	if (format === "agent") return agentRiskLines(assessment).join("\n");
	return textRiskLines(assessment).join("\n");
}

export function renderVerdict(verdict: Verdict, format: OutputFormat): string {
	if (format === "json") return JSON.stringify(verdict, null, 2);
	if (format === "agent") return agentVerdictLines(verdict).join("\n");
	return [`VERDICT: ${verdict.name}`, "", ...verdict.results.map(resultLine), ""].join("\n");
}

function textRiskLines(assessment: RiskAssessment): string[] {
	return [
		`RISK SCORE: ${assessment.score} / ${MAX_SCORE}`,
		"",
		`  ${bar(assessment.score)}`,
		"",
		...assessment.contributions.map((entry) => `  ${entry.label.padEnd(LABEL_WIDTH)}${signed(entry.points).padStart(5)}`),
		"",
		`  LEVEL: ${assessment.level}`,
		"",
	];
}

// Ranked by magnitude before capping, so what survives truncation is what moved
// the score most, rather than whichever rules happen to be declared first.
function agentRiskLines(assessment: RiskAssessment): string[] {
	const ranked = [...assessment.contributions].sort((left, right) => Math.abs(right.points) - Math.abs(left.points));
	const shown = ranked.slice(0, AGENT_CONTRIBUTION_CAP);
	const omitted = ranked.length - shown.length;
	return [
		`risk ${assessment.score} ${assessment.level}`,
		...shown.map((entry) => `${signed(entry.points)} ${entry.id}`),
		...(omitted > 0 ? [`... ${omitted} more rule(s) omitted`] : []),
	];
}

// Only the results that are not a plain pass: a passing verifier is the
// expected case and says nothing an agent needs to spend context on, while a
// skip or a failure is the whole reason the verdict is what it is.
function agentVerdictLines(verdict: Verdict): string[] {
	const notable = verdict.results.filter((result) => result.status !== "passed");
	return [
		`verdict ${verdict.name}`,
		...notable.map((result) => `${result.id} ${result.status}${result.reason === null ? "" : ` - ${result.reason}`}`),
	];
}

// The status is printed after the id and never merged into one word with it: a
// line reading "tests passed" for a verifier that was skipped is the single
// most expensive thing this renderer could get wrong.
function resultLine(result: Verdict["results"][number]): string {
	return `  ${result.id.padEnd(20)}${result.status}${result.reason === null ? "" : `  ${result.reason}`}`;
}

function bar(score: number): string {
	const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((score / MAX_SCORE) * BAR_WIDTH)));
	return `${"#".repeat(filled)}${".".repeat(BAR_WIDTH - filled)}`;
}

function signed(points: number): string {
	return points >= 0 ? `+${points}` : String(points);
}
