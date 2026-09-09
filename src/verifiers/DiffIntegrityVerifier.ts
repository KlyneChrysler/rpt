import { diffNameStatus, diffStat, type DiffEntry } from "../git/diff.js";
import { failed, passed, type RunContext, type Verifier, type VerifierResult } from "./Verifier.js";

const MANIFESTS = [
	"package.json",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lockb",
	"go.mod",
	"go.sum",
	"Cargo.toml",
	"Cargo.lock",
	"pyproject.toml",
	"requirements.txt",
	"poetry.lock",
	"Gemfile.lock",
];

export const diffIntegrityVerifier: Verifier = {
	id: "diff-integrity",
	async run(context: RunContext): Promise<VerifierResult> {
		const entries = await diffNameStatus(context.repoRoot, context.baseSha, context.endSha);
		const observedPaths = entries.flatMap(observedPathsOf);
		const claimed = new Set(context.claims.mutatedPaths);
		const undeclared = observedPaths.filter((path) => !claimed.has(path));
		const { added, removed } = await diffStat(context.repoRoot, context.baseSha, context.endSha);
		const facts = {
			observedPaths,
			claimedPaths: context.claims.mutatedPaths,
			undeclared,
			manifestChanged: observedPaths.some(isManifest),
			added,
			removed,
		};
		if (undeclared.length === 0) return passed("diff-integrity", facts);
		return failed(
			"diff-integrity",
			`${undeclared.length} file(s) changed that the agent never declared: ${undeclared.join(", ")}`,
			facts,
		);
	},
};

// git reports a rename under its new path alone, so the old path would
// otherwise vanish from the observed set entirely. A rename that lands at an
// undeclared destination is already caught without this - the new path itself
// is unclaimed. What this catches instead is the case where the agent's claim
// happens to name only the destination: the origin path is real, on-disk
// content moved away from it, and without surfacing it here that move is
// invisible to this verifier (e.g. a sensitive file quietly renamed into an
// innocuous-looking path the agent does go on to declare).
function observedPathsOf(entry: DiffEntry): string[] {
	return entry.oldPath === undefined ? [entry.path] : [entry.oldPath, entry.path];
}

function isManifest(path: string): boolean {
	const name = path.split("/").pop() ?? path;
	return MANIFESTS.includes(name);
}
