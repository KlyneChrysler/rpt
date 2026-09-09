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

This is Plan 1 of the project. **It records and replays. It does not verify changes,
score risk, or gate a commit.** Those are a later plan. Anything that sounds like
adjudication - a run's `state` field can reach `VERIFYING`, `VERIFIED`, `FAILED`,
`AWAITING_APPROVAL`, and so on - is scaffolding for that later plan; nothing in this
codebase currently drives a run into any of those states. A run recorded today ends
its life in `ENDED`.

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

Run once per repository, from the repository root:

```bash
rpt init
```

This installs `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and
`Stop` hooks into `.claude/settings.json` (merged in, never overwritten - if that
file exists and isn't valid JSON, `rpt init` refuses to touch it rather than guess),
adds `.rpt/` to `.gitignore`, and scaffolds two files if they don't already exist:

- `rpt.config.json` - test/coverage commands, sensitive-path globs and risk
  thresholds. The whole file is inert in Plan 1: `loadConfig` parses and validates
  it, but nothing calls `loadConfig` anywhere in this codebase yet. It's scaffolded
  now so the shape is settled for the verification plan that comes next, not
  because anything reads it today.
- `.rpt/pricing.json` - **ships empty.** rpt does not know what any model costs and
  will not guess. A model with no entry here reports no cost for its usage, not an
  invented one. Fill in `input`, `output`, `cacheRead` and `cacheCreate` (USD per
  million tokens) per model yourself if you want that pricing function to have
  anything to work with.

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
  never be verified later, so every surface (`rpt run`, `rpt status`) prints a
  visible warning for one instead of pretending it's clean.

Event delivery prefers a small local collector daemon over a Unix socket, so a hook
invocation can return fast instead of waiting on a file lock; nothing in Plan 1 spawns
that daemon automatically yet, so in practice every event today is appended directly
to the log. If a delivery attempt fails outright - no daemon, and the direct append
also fails - that failure itself becomes a `GapRecorded` event rather than vanishing.

## Commands

All commands accept `--format text|json|agent` (`text` is the default; `agent` is a
denser form meant to be read back into an agent's own context).

| Command | What it does |
|---|---|
| `rpt init` | Installs hooks and scaffolds config/pricing files. |
| `rpt status` | Shows the current active run, if any. |
| `rpt runs` | Lists every run recorded in this repository. |
| `rpt run <id>` | Shows one run: task, state, claims, and model usage counts. |
| `rpt events <id>` (alias `rpt replay`) | Prints the full event timeline for a run. |

There is no write or mutating command beyond `rpt init` and the internal `rpt hook`
entry point Claude Code itself calls - every other command is read-only.

## Where data lives

Everything rpt writes lives under `.rpt/` at the repository root (ignored by git,
per the `.gitignore` line `rpt init` adds):

```
.rpt/
  current            # pointer to the currently-open run, if any
  index.jsonl         # append-only summary row per run (id, task, state, timestamps)
  pricing.json         # per-model USD rates; ships empty
  runs/
    1/
      events.jsonl      # this run's full, checksummed event log
```

Git snapshots themselves are not stored under `.rpt/` - they're plain git commit
objects, reachable from `refs/rpt/runs/<id>/base` and `refs/rpt/runs/<id>/end`,
written through a temporary `GIT_INDEX_FILE` so your real index and working tree are
never staged, modified, or otherwise touched by taking a snapshot.

## The shape of a run

```ts
type AgentRun = {
	id: number;
	task: string;
	state: RunState;        // RUNNING or ENDED in this plan
	baseSha: string | null;
	endSha: string | null;
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
