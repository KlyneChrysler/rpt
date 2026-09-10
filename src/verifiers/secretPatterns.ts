export type SecretPattern = { rule: string; test: RegExp };

export const SECRET_PATTERNS: readonly SecretPattern[] = [
	{ rule: "private-key", test: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ rule: "aws-access-key-id", test: /\bAKIA[0-9A-Z]{16}\b/ },
	{ rule: "bearer-token", test: /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}/i },
	{ rule: "url-credentials", test: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/i },
];

// No \b here: JS word boundaries don't see the case change inside a camelCase
// identifier like `apiSecret`, so a strict \b(...)\b would silently miss the
// most common real-world spelling of these names. A plain substring test over-
// matches (e.g. "secretary"), but that only widens this pre-filter - the literal
// still has to clear the length, entropy, and placeholder checks below.
export const SECRET_NAME = /secret|token|password|passwd|api[_-]?key|private[_-]?key|credential/i;

export const PLACEHOLDER = /(your|example|sample|dummy|placeholder|changeme|xxxx|redacted|<[^>]+>|\.\.\.)/i;
