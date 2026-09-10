import { parseHunkHeader } from "../git/hunkHeader.js";
import { PLACEHOLDER, SECRET_NAME, SECRET_PATTERNS } from "./secretPatterns.js";

export type SecretFinding = { rule: string; path: string; line: number };

const MIN_SECRET_LENGTH = 20;
const MIN_ENTROPY_BITS_PER_CHAR = 3.5;

export function scanSecrets(patch: string): SecretFinding[] {
	const findings: SecretFinding[] = [];
	let path = "unknown";
	let line = 0;
	for (const raw of patch.split("\n")) {
		if (raw.startsWith("+++")) {
			// The new-file header line itself, e.g. "+++ b/x.ts" for an ordinary
			// change or "+++ /dev/null" for a deletion - never diff content, even
			// though it starts with "+".
			if (raw.startsWith("+++ b/")) path = raw.slice("+++ b/".length);
			continue;
		}
		// Counting added lines ordinally from the top of the file, instead of
		// resetting to the hunk header's real starting line, gives the right
		// answer for a single-hunk diff and a wrong one for any later hunk - and
		// a confidently wrong location in a security finding is worse than none,
		// since it is what lands in the event log and a git note.
		const header = parseHunkHeader(raw);
		if (header !== null) {
			line = header.newStart;
			continue;
		}
		if (raw.startsWith("+")) {
			findings.push(...findingsIn(raw.slice(1), path, line));
			line += 1;
		} else if (raw.startsWith(" ")) {
			// An unchanged context line still occupies a line in the new file.
			line += 1;
		}
		// A removed line ("-...") occupies no position in the new file at all.
	}
	return findings;
}

function findingsIn(content: string, path: string, line: number): SecretFinding[] {
	const matched = SECRET_PATTERNS.filter((pattern) => pattern.test.test(content));
	const rules = matched.map((pattern) => pattern.rule);
	if (looksLikeSecretAssignment(content)) rules.push("high-entropy-assignment");
	return rules.map((rule) => ({ rule, path, line }));
}

function looksLikeSecretAssignment(content: string): boolean {
	if (!SECRET_NAME.test(content)) return false;
	const literal = /["'`]([^"'`]{20,})["'`]/.exec(content)?.[1];
	if (literal === undefined || PLACEHOLDER.test(literal)) return false;
	return literal.length >= MIN_SECRET_LENGTH && shannonBits(literal) >= MIN_ENTROPY_BITS_PER_CHAR;
}

function shannonBits(value: string): number {
	const counts = new Map<string, number>();
	for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
	return [...counts.values()].reduce((bits, count) => {
		const probability = count / value.length;
		return bits - probability * Math.log2(probability);
	}, 0);
}
