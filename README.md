# rpt

rpt is an independent flight recorder for AI coding agent runs. It sits behind a
Claude Code hook, watches what an agent does to a git repository during one session,
and writes down what happened as an append-only, checksummed log - a record that is
derived from the agent's own tool calls and from git itself, not from anything the
agent chooses to tell you about its own work.

A run's identity does not depend on the agent behaving well. If a hook is lost, the
log says so instead of silently closing the gap. If the agent writes a file and never
mentions it, rpt still sees it, because the observation comes from asking git what
changed between two snapshots, not from trusting the agent's own claims.

rpt also verifies, scores risk, and requires a gated, explicit human decision
before a run counts as approved - not yet a commit gate itself (nothing in this
codebase hooks `git commit`; see "Commands" below for what actually ships as a
CLI command today), but the engine that decision would sit behind. A run's
`state` field is not scaffolding: it can reach `VERIFYING`, `VERIFIED`, `FAILED`,
`UNVERIFIED`, `AWAITING_APPROVAL`, `APPROVED` and `REJECTED`, driven there by
`verifyRun` and `approveRun`/`rejectRun` (`src/app/`). Verification runs this
project's own test command inside a git worktree isolated from your working tree;
risk is assessed against `rpt.config.json`, read once as a snapshot taken at each
run's own start rather than live (see "Threat model" below for exactly what that
does and does not protect against); and a CRITICAL-risk run has no approval path
at all. None of `verifyRun`/`approveRun`/`rejectRun` is wired into a CLI command
yet - `rpt` today only records, lists and replays runs (see "Commands") - but the
engine underneath is real, not a placeholder, and `rpt.config.json` is a live
input to it from the moment `rpt init` scaffolds one.

## Install

Requires Node 22+.

```bash
pnpm install
pnpm build
```

`rpt` is a single binary (`dist/cli/index.js`, published as `bin: rpt`). Link it onto
your `PATH` however you normally do that for a local package (`pnpm link --global`,
or point a shell alias at `dist/cli/index.js`).

## `rpt init`

Run once per repository. It can be run from anywhere inside the repository - it
finds the git root and initialises there, and refuses outright if there is no git
repository above the working directory, because every run rpt records begins with a
git snapshot and a directory that isn't a repository can never record one:

```bash
rpt init
```

This installs `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and
`Stop` hooks into `.claude/settings.json` (merged in, never overwritten - if that
file exists and isn't valid JSON, `rpt init` refuses to touch it rather than guess),
adds `.rpt/` to `.gitignore`, and scaffolds two files if they don't already exist:

- `rpt.config.json` - test/coverage commands, sensitive-path globs and risk
  thresholds. This is a live input, not scaffolding: `verifyRun` reads it (via a
  per-run snapshot, not a live read - see "Threat model") to choose what to run,
  and `approveRun`/`rejectRun` read it to score risk and decide whether a run is
  CRITICAL. It is also, unavoidably, owned by the same repository the agent is
  working in, which is exactly what "Threat model" is about. **Verification, when
  it runs, executes this project's own test command - arbitrary code chosen by the
  project, not by rpt - inside a git worktree isolated from your working tree. That
  isolation is not a sandbox: the command runs with the same OS-level privileges as
  `rpt` itself, and rpt does not restrict what it can read, write, or reach over
  the network.**
- `.rpt/pricing.json` - **ships empty.** rpt does not know what any model costs and
  will not guess. A model with no entry here reports no cost for its usage, not an
  invented one. Fill in `input`, `output`, `cacheRead` and `cacheCreate` (USD per
  million tokens) per model yourself if you want that pricing function to have
  anything to work with. Each rate must be a finite, non-negative number or an
  explicit `null` meaning "known to be unknown"; an entry that is anything else -
  a missing key, an extra key, a string, a negative number - is dropped at load
  time with a line on stderr and its model reports no cost, because a
  plausible-looking wrong number is worse than no number.

## What gets recorded

Every hook invocation from Claude Code becomes zero or more events, appended to
`.rpt/runs/<id>/events.jsonl` - one JSON object per line, each carrying a checksum
over its own contents. A `SessionStart` opens a run and takes a git snapshot of the
working tree exactly as it stood (via a scratch index, so your real staging area is
never touched); a `Stop` closes it with a second snapshot. Everything in between -
prompts, tool calls, file writes, shell commands, model token usage pulled from the
session transcript - is folded into that run:

- **Claims**: which paths the agent's own tool calls said they touched, and which
  commands it ran. This is the agent's story, not verified against anything.
- **Observed diff**: `git diff` between the run's two snapshots. This is asked of
  git directly and does not read the claims at all - it will show a file the agent
  never mentioned, which is the point.
- **Usage**: per-model token counts (input, output, cache read, cache create) read
  from the Claude Code transcript. A cost-accounting function exists
  (`src/pricing/cost.ts`) that prices usage against `.rpt/pricing.json` and reports
  no cost, not a guessed one, for any model without a rate on file - but no CLI
  command surfaces a dollar figure yet.
- **Gaps**: if an event is lost - a torn write from a crash, a delivery that
  couldn't reach the daemon and couldn't be appended directly either - the run is
  marked `hasGaps: true` rather than silently missing the event. A gapped run can
  never be verified later, so every surface (`rpt run`, `rpt runs`, `rpt status`,
  `rpt events`) prints a visible warning for one instead of pretending it's clean.

Event delivery prefers a small local collector daemon over a Unix socket, so a hook
invocation can return fast instead of waiting on a file lock; nothing in Plan 1 spawns
that daemon automatically yet, so in practice every event today is appended directly
to the log. A frame the daemon could not decode, or could not append, is answered as
failed rather than acknowledged, so the hook falls back instead of believing a write
that never happened.

**Known limitation, carried to the next plan.** That acknowledgement is per batch of
complete lines, not per frame across chunk boundaries: if a frame arrives split across
more than one TCP chunk, the daemon has no complete line to persist yet and still
answers `ok` for the empty batch, so the hook believes a delivery that has not
happened. It is a real hole in the guarantee above, verified against the built daemon.
Nothing in Plan 1 starts the daemon, so nothing today can reach it - every event goes
down the direct-append path. It is fixed in the plan that actually starts the daemon.

When both routes fail - no daemon, and the direct append also fails - rpt writes a
`GapRecorded` event as a last resort, deliberately *without* the file lock the direct
append just failed to take. That is what makes it a different failure mode rather
than the same one retried: a lock a crashed process never released can stop the
append but cannot stop the gap. A torn gap line is itself read back as a gap, so
writing it unlocked can never make the record claim more than the truth.

One failure survives even that, and rpt does not claim otherwise: if the log's own
directory cannot be written at all (no permissions, no space, a file standing where
the directory has to go) then nothing can be recorded there, including the gap. rpt
writes that to stderr and the event is lost. It is the one case where a lost event
does not become a `GapRecorded`, and it is the reason `.rpt/` being writable is a
precondition of the record meaning anything.

## Commands

All commands accept `--format text|json|agent` (`text` is the default; `agent` is a
denser form meant to be read back into an agent's own context).

| Command | What it does |
|---|---|
| `rpt init` | Installs hooks and scaffolds config/pricing files. |
| `rpt status` | Shows the newest run rpt is not done with: the one in progress, or one that has ended but has not been recorded yet. |
| `rpt runs` | Lists every run recorded in this repository, warning first about corrupt index lines and about sessions that failed to start. |
| `rpt run <id>` | Shows one run: task, state, claims, and model usage counts. |
| `rpt events <id>` (alias `rpt replay`) | Prints the full event timeline for a run, warning first if that log has unreadable lines. |

Every command works from anywhere inside the repository, not just its root: rpt walks
up to the git root (or the nearest `.rpt/`) to find it. If there is no repository above
the working directory at all, that is what it says - it does not answer with an empty
history and a zero exit, which is what a genuinely empty repository looks like.

There is no write or mutating command beyond `rpt init` and the internal `rpt hook`
entry point Claude Code itself calls - every other command is read-only.

## Where data lives

Everything rpt writes lives under `.rpt/` at the repository root (ignored by git,
per the `.gitignore` line `rpt init` adds):

```
.rpt/
  current                 # pointer to the currently-open run, if any
  index.jsonl             # append-only summary row per run (id, task, state, timestamps)
  pricing.json            # per-model USD rates; ships empty
  start-failures.jsonl    # sessions that could not open a run at all, and why
  runs/
    1/
      events.jsonl        # this run's full, checksummed event log
      config.json         # rpt.config.json snapshotted at this run's start (src/store/runConfig.ts)
      verdict.json        # this run's verifyRun outcome, schema-validated and bound to this run's id
      approval.json       # this run's recorded human decision, if any - same treatment as verdict.json
```

### Recovering from a damaged run index

A line in `index.jsonl` that is not a well-formed entry - hand-edited, or half-written
by a crash - is counted as corrupt, reported by `rpt runs`, and **stops new runs from
starting** until it is removed. That is deliberate, and it is the largest behavioural
change in the recorder: the next run id is the highest id on file plus one, so while a
line cannot be read the highest id is not knowable, and allocating anyway would either
collide with a run already on disk or number from a value that was never read. A run
numbered on top of a hole is silent, permanent damage; refusing is loud and takes one
edit to undo.

There is no in-tool repair command in Plan 1. To recover, open `.rpt/index.jsonl` and
delete the line(s) `rpt runs` is warning about - it is one JSON object per line, and
the file is a rebuildable cache, not the source of truth (that is each run's event
log), so deleting a bad line loses nothing but the listing row it was meant to be.
Until you do, every session records nothing, and each one appends its reason to
`start-failures.jsonl` so `rpt runs` keeps saying why.

`start-failures.jsonl` is the third of rpt's three records of its own failures, and
the only one that exists because there was nowhere else to put it. A `GapRecorded`
event covers a lost event inside a run; a corrupt-line count covers a damaged index
row; but a session whose run never started has no event log to gap and no index row
worth reading, and its absence from the history is otherwise indistinguishable from a
session that simply never happened. `rpt runs` prints a warning naming the count and
the newest reason whenever this file is non-empty.

A row in the index that never recorded any events is either a run still starting -
the id is reserved before the git snapshot, which on a large repository takes seconds -
or the residue of a failed start. `rpt status` distinguishes them by whether a reason
was recorded: a run that is starting is reported as `STARTING` and exits zero, and a
run that failed to start is reported with its reason and exits non-zero. The next
session that starts successfully supersedes either.

rpt also never answers "no such run" for a run it has evidence of. A run is *absent*
only when nothing anywhere claims it existed - no index row, no log. A run with
surviving log lines or an index row but no readable `RunStarted` (a crash tore the
start event off the front) is *damaged*, and says so: `rpt events` prints whatever
survived with the gap warning above it, and `rpt run` reports the damage rather than
denying the run. Missing evidence is never reported as nonexistence.

Git snapshots themselves are not stored under `.rpt/` - they're plain git commit
objects, reachable from `refs/rpt/runs/<id>/base` and `refs/rpt/runs/<id>/end`,
written through a temporary `GIT_INDEX_FILE` so your real index and working tree are
never staged, modified, or otherwise touched by taking a snapshot.

## The shape of a run

```ts
type AgentRun = {
	id: number;
	task: string;
	state: RunState;        // RUNNING, ENDED, VERIFYING, VERIFIED, FAILED, UNVERIFIED,
	                         // AWAITING_APPROVAL, APPROVED, REJECTED, or RECORDED
	baseSha: string | null;
	endSha: string | null;
	configFingerprint: string | null;   // fingerprint of this run's config snapshot; null
	                                     // only for a run recorded before that feature existed
	startedAt: string;
	endedAt: string | null;
	hasGaps: boolean;
	claims: { mutatedPaths: string[]; commands: string[] };
	usage: { model: string; input: number; output: number; cacheRead: number; cacheCreate: number }[];
};
```

`claims` is what the agent said. `baseSha`/`endSha` are what you hand to
`git diff` to find out what actually happened. rpt keeps those two things separate
on purpose - collapsing them into one would defeat the reason this tool exists.

## Threat model

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
called automatically by `approveRun`/`rejectRun` - with its own, narrower gate:
it refuses an event claiming CRITICAL risk the same way a fresh decision would,
and refuses one naming a different verdict than what is actually on disk. Its
own limit: it checks the level *recorded in the event*, not a fresh assessment
(re-judging an approval against today's score is a separate rule this project
does not break), so a forged event that understates its own risk - claims LOW
when the change was actually CRITICAL - is not caught by this check. Nothing
about `healApproval` is meant to be stronger than what a fresh decision already
grants; recovering an interrupted write is the whole of its job.

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
same read: one removal turning the protection and the alarm off together. A
run whose `RunStarted` recorded a fingerprint now forces the drift finding
instead whenever the snapshot is missing, corrupt, or does not match that
fingerprint - an edit made during or after a run can still not change what that
run is scored against, and now cannot silence the finding that says so either.
What this does not close: the snapshot for a run is only as trustworthy as
whatever `rpt.config.json` already said the moment that run started, which a
*previous*, already-approved run could have poisoned. Closing that would
require the config itself to be an append-only, independently-reviewed record,
which it is not.

### Why none of this defends against a hostile agent

An agent with write access to the repository has write access to every record
listed above, the same as any other file it can edit, and to `rpt.config.json`
itself. Concretely, none of the following require exploiting a bug: an agent can
write `.rpt/runs/<id>/approval.json` directly, in the exact schema-valid shape a
real approval takes, without ever calling `approveRun`. It can append a forged
`ApprovalGranted` event directly to `events.jsonl` and wait for (or itself call)
`healApproval` - which will refuse a forgery that claims CRITICAL or names the
wrong verdict, but not one that understates its own risk, as above. It can run
inside a pseudo-terminal it fully controls (`script`, `expect`, a harness that
gives it raw shell access), which can make the `isTTY` checks *and* a typed
response at `/dev/tty` succeed with no human ever involved, if it is willing to
script that impersonation. None of these are exotic: they are what "has write
access to the repository and can spawn processes" already grants. A checksum
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
