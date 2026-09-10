import { PLACEHOLDER, SECRET_NAME, SECRET_PATTERNS } from "./secretPatterns.js";

export type SecretFinding = { rule: string; path: string; line: number };

const MIN_SECRET_LENGTH = 20;
const MIN_ENTROPY_BITS_PER_CHAR = 3.5;

export function scanSecrets(patch: string): SecretFinding[] {
	const findings: SecretFinding[] = [];
	let path = "unknown";
	let line = 0;
	for (const raw of patch.split("\n")) {
		if (raw.startsWith("+++ b/")) {
			path = raw.slice("+++ b/".length);
			line = 0;
			continue;
		}
		if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
		line += 1;
		findings.push(...findingsIn(raw.slice(1), path, line));
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
