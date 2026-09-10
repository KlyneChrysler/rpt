# Threat model

Written for a reader deciding how much weight a verdict can carry. It states
what rpt checks, what it deliberately does not, and where the remaining gaps
are, without hedging any of it.

Say this plainly, without hedging: rpt is a check against agent error, drift, and
unverified work. It is not a check against an agent that is deliberately attacking
rpt itself.

### What rpt actually checks before recording a human decision

`approveRun`/`rejectRun` (`src/app/approveRun.ts`) will not record a fresh
decision without, in order: a cheap pre-check that the caller-supplied `Actor` is
not a known agent context (an "unknown" context is deliberately *not* refused
here - it falls through to the confirmation below, which is the actual proof;
see the comment on `AgentContextSignal` in that file for the full reasoning) and
claims an interactive terminal; the run's own risk, computed from its verdict and
its config snapshot (below); and, for any decision that reaches that point, a
confirmation that must be *typed*, at that moment, at the process's controlling
terminal (`/dev/tty`, not standard input, so piping or redirecting stdin does not
satisfy it) - not read from any field the caller supplies. That confirmation is
bound to the specific run id, decision, verdict name and risk level
(`confirmationPhrase`): a captured "yes" does not authorise a second decision, on
this run or any other.

A CRITICAL-risk run has no approval path at all: `decide()` (`src/domain/policy.ts`)
returns `"block"` for CRITICAL before it even looks at the verdict, and
`record()`'s only enforcement of that - gated on `decision === "approved"`, since
rejecting a CRITICAL run is a human saying no, not a sign-off, and must stay
recordable - is the sole place in the codebase a *fresh* decision enforces that
prohibition. Its limit: the risk level it gates on is computed from a config
snapshot taken at this run's start (below), not from an unbounded read: a project
can still tune `rpt.config.json`'s thresholds close to the schema's `[0, 100]`
ceiling to make CRITICAL hard, if not impossible, to reach honestly, and that
edit is itself a scored, visible finding (`rpt-config-changed`) rather than a
silent one - visible, not prevented.

A run whose approval event exists but whose file does not (an interrupted write)
is recovered by `healApproval`, a separate, explicitly-named operation - never
called automatically by `approveRun`/`rejectRun`, so skipping any of the checks
below is something a person has to write down on purpose. It takes the same
`Actor` and runs the same `assertHuman`/approver-name checks, and requires the
same typed confirmation - built from the level and verdict *recorded in the
event* rather than a fresh assessment, since re-judging a decision against
today's score is a separate rule this project does not break. State plainly
what that means rather than understating it: healing is not "not meant to be
stronger than a fresh decision" - a fresh decision requires a non-agent actor,
an allowlisted name and a typed phrase, and an earlier shape of `healApproval`
required none of them, which the second review of this mechanism demonstrated
directly against the built binary. It additionally refuses an event whose
verdict name does not match what is actually on disk, and refuses one whose
`configFingerprint` is not shaped like a real one or does not match this run's
own recorded fingerprint or what resolving its config now produces - checks a
fresh decision has no equivalent for, because a fresh decision never reads a
historical claim at all. The one thing that remains genuinely unclosable: a
human confirming a heal cannot re-derive the recorded level from recorded data
alone, so a forged event that understates its own risk - claims LOW when the
change was actually CRITICAL - is not caught. That is the actual residual gap,
and it is narrow.

### What is, and is not, confined to `.rpt/`

The event log, the verdict, the risk assessment and the approval all live under
`.rpt/` in the repository the agent is working in, validated on read (schema plus
run-id binding on both the verdict and the approval record) so a hand-edited or
mismatched file is refused rather than trusted. Risk scoring also depends on
`rpt.config.json` at the repository root - outside `.rpt/`, and just as writable
by an agent as anything else in the repo. Each run snapshots the effective config
once, at its own start (`src/store/runConfig.ts`), and verification and approval
judge that run against the snapshot, not a live read.

That snapshot is itself verified, not merely consulted: `RunStarted` records a
fingerprint of it at the moment the run begins, independent of anything that
happens to the snapshot file afterward. A missing snapshot used to read
identically to "this run predates the feature" and silently fall back to a live
read - which also silenced the drift finding meant to expose exactly that,
since the fallback and the "live" side of the drift comparison were then the
same read: one removal turning the protection and the alarm off together.
Welding the alarm on by itself was still not enough, and shipped that way once:
a run whose `RunStarted` recorded a fingerprint forced the drift finding
whenever the snapshot was missing, corrupt, or did not match that fingerprint,
but the config actually used to score the run on that path was still a live
read of `rpt.config.json` - the exact file whoever deleted or altered the
snapshot already controls, so the "protection" and the alarm were still two
different things and only one of them was ever fixed. On that path the config
used is now `DEFAULT_CONFIG` - rpt's own shipped defaults, not the
repository's file - so an edit made during or after a run *cannot* change what
that run is scored against in any of the three cases the fingerprint check
exists to catch (missing, corrupt, or mismatched), and the drift finding still
fires so the substitution is visible rather than silent. Restoring the real
snapshot (or a fresh run, which snapshots again) recovers the real config
immediately: this is a degradation, not a refusal, on purpose.

Substituting the defaults alone was itself half a fix, and it shipped that way
too. "Never the repository's file" is directionally right and absolutely wrong,
because a project's own config may be *stricter* than rpt's defaults: for any
repository that sets a block threshold below fifty-one, deleting one file inside
`.rpt/` moved a run from CRITICAL to approvable, and the typed confirmation then
read the human the downgraded level, so they approved honestly on a false
premise. The rule is not "never the repository's file", it is "never the laxer
of the two". On the degraded path a run is now assessed under *both* the
defaults and the live config, and judged by whichever result is stricter
(`src/app/assessRun.ts`). The defaults remove the attacker-relaxed direction;
the live config removes the project-relaxed direction; an attacker who edits the
live config to be stricter only ever blocks an approval. The cost, when this is
wrong, is a run judged more strictly than either config alone would judge it, on
a path that already forces a visible drift finding.

What this does not close: the snapshot for a run is only as trustworthy as
whatever `rpt.config.json` already said the moment that run started, which a
*previous*, already-approved run could have poisoned. Closing that would
require the config itself to be an append-only, independently-reviewed record,
which it is not.

### What the commit gate is and is not

The gate is a `pre-commit` hook. It stops a commit the way any pre-commit hook
stops a commit, which is to say: completely, until someone chooses otherwise.
`RPT_BYPASS=1`, `git commit --no-verify`, deleting `.git/hooks/pre-commit`, or
calling `git commit-tree` directly all get past it, and the first of those is a
documented, supported escape hatch. What the gate buys is not prevention but
cost and visibility: a bypass is recorded with the score at the time, and a
commit that landed without a gate result has no attestation note, which is
itself visible in review.

CRITICAL is the one thing the bypass does not cover. That is a property of the
gate's own ordering, not of git: someone who removes the hook is not gated at
all, by rpt or anything else.

### Why none of this defends against a hostile agent

An agent with write access to the repository has write access to every record
listed above, the same as any other file it can edit, and to `rpt.config.json`
itself. Concretely, none of the following require exploiting a bug: an agent can
write `.rpt/runs/<id>/approval.json` directly, in the exact schema-valid shape a
real approval takes, without ever calling `approveRun`. It can append a forged
`ApprovalGranted` event directly to `events.jsonl` and wait for a human to call
`healApproval` on it - which will refuse a forgery that claims CRITICAL or
names the wrong verdict, but not one that understates its own risk, as above;
completing the forgery itself, rather than waiting, needs the same pseudo-
terminal impersonation as a fresh decision, since `healApproval` requires the
same actor and confirmation checks - calling the function is not enough by
itself. It can run inside a pseudo-terminal it fully controls (`script`,
`expect`, a harness that gives it raw shell access), which can make the
`isTTY` checks *and* a typed response at `/dev/tty` succeed with no human ever
involved, if it is willing to script that impersonation. None of these are
exotic: they are what "has write access to the repository and can spawn
processes" already grants. A checksum
chained over events, verified by the same machine running the agent, is a speed
bump against an accidental or careless write, not a defence against a deliberate
one - the machine that could forge the write can just as easily recompute the
chain over the forgery.

What rpt's checks actually raise is the cost of an *unintentional* or *incidental*
bypass - an agent whose environment happens to look interactive no longer passes
by accident, and a bypass now requires either forging the record directly
(skipping `approveRun`/`rejectRun` entirely) or actively impersonating a person
at a real terminal, not just looking like one. That is real, useful hardening
against carelessness and against tooling that was never trying to defeat the
check. It is not, and does not claim to be, a defence against an agent actively
trying to.

If you need a guarantee that survives a hostile agent with repository write
access, it has to come from outside this repository entirely: a review gate the
agent cannot write to (a branch protection rule enforced by a server the agent
has no credentials for, a human approval step in a CI system, a signature the
agent cannot produce). rpt's job ends at making the agent's own claims checkable
and making the one place a human decision is recorded resistant to accidental
self-clearing - not at defending that record against an agent that has decided
to attack it.
