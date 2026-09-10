# Using rpt

Everything the README's quickstart leaves out: what gets recorded, every
command, the config switches, and how to recover when something breaks.

> Install and first-run setup are in the [README](../README.md).

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
installs `pre-commit` and `post-commit` hooks into `.git/hooks` (appended to any
hook already there, never replacing it), adds `.rpt/` to `.gitignore`, and scaffolds
two files if they don't already exist:

- `rpt.config.json` - test/coverage commands, sensitive-path globs and risk
  thresholds. This is a live input, not scaffolding: `verifyRun` reads it (via a
  per-run snapshot, not a live read - see [Threat model](threat-model.md)) to choose what to run,
  and `approveRun`/`rejectRun` read it to score risk and decide whether a run is
  CRITICAL. It is also, unavoidably, owned by the same repository the agent is
  working in, which is exactly what "Threat model" is about. **Verification, when
  it runs, executes this project's own test command - arbitrary code chosen by the
  project, not by rpt - inside a git worktree isolated from your working tree. That
  isolation is not a sandbox: the command runs with the same OS-level privileges as
  `rpt` itself, and rpt does not restrict what it can read, write, or reach over
  the network.**
- `.rpt/pricing.json` - **ships with no rates.** rpt does not know what any model
  costs and will not guess. It does name the models it can see this repository has
  actually used, read from Claude Code's own session transcripts, each seeded with
  explicit `null` rates - so filling the file in means editing a list rather than
  compiling one, and a model id is not something anybody remembers. A model with a
  `null` or missing rate reports no cost for its usage, not an invented one. Fill
  in `input`, `output`, `cacheRead` and `cacheCreate` (USD per million tokens) per
  model yourself if you want that pricing function to have anything to work with.
  Seeding is a convenience and degrades quietly: a repository Claude Code has never
  run in, or a transcript layout that has moved, produces an empty rates object and
  no error. Each rate must be a finite, non-negative number or an
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
  no cost, not a guessed one, for any model without a rate on file. A run rpt
  recorded no usage for at all reports its cost as unknown rather than as zero, in
  the console and in the attestation both.
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

That acknowledgement used to be per batch of complete lines rather than per frame: a
frame arriving split across more than one TCP chunk left the daemon no complete line
to persist, and it answered `ok` for the empty batch anyway, so the hook believed a
delivery that had not happened. The daemon now stays silent until it has a whole
frame, so the client either gets a real answer or times out and falls back - both
honest, where the acknowledgement was not.

**Starting it.** The first hook of a session finds no daemon, appends its event
directly, and then starts one - after the event is safely recorded, never before,
so a process spawn never sits between the agent and its own tool call. Every hook
after that takes the socket. One daemon runs per repository, enforced by a lock
rather than by hope, so several hooks firing at once cannot race several daemons
into existence, and a daemon killed rather than closed leaves a lock that goes
stale rather than one that blocks every future start.

It shuts itself down after five minutes with nothing connected, because a daemon
per repository living forever after a session ends is a process leak nobody asked
for. `rpt daemon` runs one in the foreground for diagnosis, and `RPT_NO_DAEMON=1`
turns auto-start off entirely for environments where a background process is
unwelcome - CI, a sandbox - at the cost of a little hook latency and nothing else.

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
| `rpt` | Opens the console on a terminal. Piped, prints the same list `rpt runs` prints, with no escape sequences. |
| `rpt init` | Installs agent hooks, git hooks, and scaffolds config/pricing files. |
| `rpt status` | Shows the newest run rpt is not done with: the one in progress, or one that has ended but has not been recorded yet. |
| `rpt runs` | Lists every run recorded in this repository, warning first about corrupt index lines and about sessions that failed to start. |
| `rpt run <id>` | Shows one run: task, state, claims, and model usage counts. |
| `rpt events <id>` (alias `rpt replay`) | Prints the full event timeline for a run, warning first if that log has unreadable lines. |
| `rpt verify <id>` | Runs every enabled verifier against the run's end snapshot in an isolated worktree and prints the verdict. `--resume` recovers a run a crash left mid-verification. |
| `rpt risk <id>` | Prints the itemised risk assessment. Refuses, naming `rpt verify`, when the run has no verdict yet. |
| `rpt diff <id>` | Prints the diff rpt observed between the run's base and end snapshots. |
| `rpt approve <id>` | Records a human approval. Requires a terminal, refuses inside a known agent context, and asks for a typed confirmation. |
| `rpt reject <id>` | Records a human rejection, under the same conditions. |
| `rpt gate` | The pre-commit gate. Exit zero allows the commit; exit one blocks it and explains why on stderr. |
| `rpt record` | Attaches the attestation note to the commit that just landed. Always exits zero. |
| `rpt daemon` | Runs the collector daemon in the foreground. Started automatically by the hook path; exposed so it can be started and diagnosed on purpose. |
| `rpt doctor` | Checks agent hooks, git hooks, config validity, pricing coverage, orphaned worktrees and the daemon. Exits one if any check failed. |

Every command works from anywhere inside the repository, not just its root: rpt walks
up to the git root (or the nearest `.rpt/`) to find it. If there is no repository above
the working directory at all, that is what it says - it does not answer with an empty
history and a zero exit, which is what a genuinely empty repository looks like.

The only commands that change anything are `rpt init`, `rpt verify`, `rpt approve`,
`rpt reject`, `rpt record`, and the internal `rpt hook` entry point Claude Code
itself calls. Everything else reads.

## Verification and the `testQuality` switch

`rpt verify` runs four checks against the run's end snapshot in an isolated
worktree: the project's own test command, diff integrity against the agent's
claims, a secret scan plus dependency audit, and change coverage.

A verdict is VERIFIED only when every check that ran passed and the log has no
gaps. **A skip is not a pass**: a check rpt could not run means rpt does not
know, and not knowing sends the run to UNVERIFIED, which the gate treats as
needing a human. That is the intended behaviour, and it is why a repository
with no coverage command is gated on every commit by default.

`verifiers.testQuality` has three settings:

| Setting | Behaviour |
|---|---|
| `require` | Change coverage below 50% fails the run. |
| `warn` (default) | Change coverage below 50% still passes, but the reason states the shortfall and the number reaches the risk engine. Coverage that could not be measured at all is still a skip, so the run is UNVERIFIED. |
| `off` | The check is not run and contributes no result. The verdict is decided over the checks that did run. |

### Recovering a run a crash left mid-verification

A crash between starting verification and writing the verdict leaves a run in
`VERIFYING` with nothing recorded. rpt refuses to re-enter that automatically,
because doing so appends a second start event and gaps the log. With the gate
installed, that refusal blocks every commit in the repository, so there is an
explicit way out:

```bash
rpt verify <id> --resume
```

It records the interruption as a gap with its reason, then verifies. Because the
run is now gapped it can never reach VERIFIED, so a commit on it still needs a
human. That is the trade being made deliberately: a recovered run is honest about
having been interrupted rather than being wedged or quietly re-rolled.

`off` removes the check rather than skipping it, deliberately. A skip is missing
evidence and downgrades a run forever; a check a project chose not to run is not
missing evidence, and treating it as such meant `off` gated every commit in that
repository permanently. Nothing is hidden by the omission: the verdict lists the
checks that ran, and the config snapshot it was judged under is fingerprinted and
drift-checked.

## The commit gate

`rpt gate` runs from `pre-commit` and answers one question: does this commit need a
human first?

It finds the newest run that has ended and has not yet been recorded, verifies it if
it has no verdict yet, scores it, and then:

- A VERIFIED run at LOW or MEDIUM risk passes. rpt stays out of the way.
- A VERIFIED run at HIGH risk needs an approval on file.
- A FAILED or UNVERIFIED run always needs an approval on file, whatever its score,
  because committing unproven work is itself the thing a human has to accept.
- A CRITICAL run is blocked outright. There is no approval path and no bypass.
- A run a human rejected keeps blocking.

When it blocks, it says so on stderr and names the command that unblocks it:

```
rpt: commit blocked

  run 1  fix authentication timeout
  risk 67 HIGH
  verdict VERIFIED

  approve with:  rpt approve 1
```

**Bypass.** `RPT_BYPASS=1 git commit ...` proceeds past everything except CRITICAL.
It does not silence rpt: the gate records the score at the time and the fact that a
bypass is what allowed the commit, and the attestation note on that commit says
`BYPASSED` in the line where an approval would otherwise go. A commit allowed
because a human approved it is never recorded as a bypass, even if the variable
happens to be set.

**Approval is human-only.** `rpt approve` and `rpt reject` refuse when the process
is running inside a known agent context, refuse without an interactive terminal, and
then - unconditionally, for every caller that gets that far - read a confirmation
phrase from the controlling terminal, `/dev/tty`, not from standard input. The
phrase names the run, the decision, the verdict and the risk level, so a "yes"
captured once cannot be replayed against a different decision. Neither verb is
reachable from the slash command plugin.

## The attestation

`rpt record` runs from `post-commit` and attaches a compact summary to the commit
under `refs/notes/rpt`:

```
run 1 | fix authentication timeout
verdict VERIFIED | risk 67 HIGH
tests 184 passed 0 failed | files 7 | cost 1.84 USD
approved despite UNVERIFIED by klyne at 2026-09-09T14:22:31Z
digest sha256:8c1f0a2b3c4d5e6f
```

The fourth line distinguishes four outcomes that must never blur together: a run
nobody had to decide reads `cleared automatically`, a verified run a human cleared
reads `approved by`, a run signed off on despite rpt being unable to verify it
reads `approved despite UNVERIFIED by`, and a run committed past a gate that asked
for a human and never got one reads `BYPASSED at ... - committed without the
approval the gate required`. File counts come from the observed diff, not from the
agent's claims. A count rpt could not parse reads `unknown`, never zero.

The digest covers the run's whole event log as read back, so a note can be checked
against the local log. The log stays in `.rpt/` and is gitignored; the note travels
with the repository and is reviewable in a pull request.

## The console

Running `rpt` on a terminal opens an Ink console: a dashboard of runs, then run
detail, events, diff, tests, risk and approval screens. The tests screen keeps
what rpt observed by running the suite itself separate from the commands the
agent claimed to run, which is the distinction the whole tool is built around.

```
[up/down] select  [enter] open  [q] quit
[v] events  [d] diff  [t] tests  [r] risk  [a] approve  [esc] back  [q] quit
```

The console is a presentation shell over `src/app/readModel.ts`, which returns plain
serialisable data. No component reads a file, invokes git, or knows how a run is
stored, and a test enforces that, so replacing this surface touches `src/ui/` and
nothing else. Its approval screen goes through the same `approveRun` path the CLI
does, including the same terminal confirmation - it offers no way around it.

## Slash commands for Claude Code

`plugin/` is an installable Claude Code plugin exposing four read-only verbs:
`/rpt:status`, `/rpt:verify`, `/rpt:risk` and `/rpt:diff`. Each shells to the binary
with `--format=agent` and reports the output verbatim.

There is no `/rpt:approve` and no `/rpt:reject`. An agent that could clear its own
run would make this whole layer decorative.

## risk.json

`rpt verify` writes the assessment beside the verdict, and `rpt gate` writes it
again for the assessment it actually judged by. The file carries the verdict name
and the fingerprint of the config it was derived from, so a copy that has stopped
describing its run says so rather than quietly disagreeing.

Nothing reads it back to make a decision. The gate and the approval both
re-derive the score from the verdict and the config snapshot on every call, on
purpose, so editing `risk.json` cannot lower the level anybody is judged at. It
exists so a person, a listing, or a tool that is not rpt can see what a run
scored without re-running the engine.

## Where data lives

Everything rpt writes lives under `.rpt/` at the repository root (ignored by git,
per the `.gitignore` line `rpt init` adds):

```
.rpt/
  current                 # pointer to the currently-open run, if any
  index.jsonl             # append-only summary row per run (id, task, state, timestamps)
  pricing.json            # per-model USD rates; seeded with model ids, no rates
  start-failures.jsonl    # sessions that could not open a run at all, and why
  daemon.sock             # the collector daemon's unix socket, while one is running
  daemon.lock             # held by the one daemon allowed to run for this repository
  runs/
    1/
      events.jsonl        # this run's full, checksummed event log
      config.json         # rpt.config.json snapshotted at this run's start (src/store/runConfig.ts)
      verdict.json        # this run's verifyRun outcome, schema-validated and bound to this run's id
      risk.json           # the assessment it was judged by, with the verdict and config it came from
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
