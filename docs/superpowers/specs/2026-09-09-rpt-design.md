# rpt — AI Agent Flight Recorder and Verification Engine

Date: 2026-09-09
Status: approved design, pre-implementation
Author: Klyne Chrysler C. Dotarot

## 1. Problem

AI coding agents report their own results. An agent says "I fixed the bug, 184 tests
pass, 7 files changed." That statement is a claim produced by the same system that
made the change. Nothing outside the agent confirms it.

Existing tooling covers adjacent ground. Claude Code has hooks, permissions, git
checkpoints and session transcripts. The Anthropic Console exposes usage by API key
and model. None of it produces a single independent, per-run record that states what
an agent actually did, what an outside process observed to be true about the result,
how risky the change is, and whether a human signed it off.

rpt produces that record.

## 2. What rpt is

An independent observability, verification and accountability layer around AI software
engineering. It observes an agent run, re-derives the facts itself, scores risk,
enforces an approval policy at the commit boundary, and emits a portable audit record.

rpt does not write code, plan work, or drive an agent. It watches, verifies, scores and
gates.

## 3. Non-goals for v1

- Not an agent, orchestrator, or model router.
- Not a hosted service. Everything is local.
- No multi-agent adapters beyond Claude Code. The adapter seam exists, one adapter ships.
- No web UI. The Ink surface is the human surface.
- No team sync, no server-side dashboard, no org policy distribution.

## 4. Principles

1. **The event log is the only state.** Run state is a fold over an append-only log.
   Nothing is mutated. Replay is therefore free and the audit record cannot contradict
   the timeline that produced it.
2. **Claims are data, observations are evidence.** Anything the agent says is stored and
   displayed but never feeds a verdict. Every fact behind a verdict was produced by rpt
   executing git, the test command, or a scanner.
3. **Missing evidence is never a pass.** A dropped event or an unrunnable verifier yields
   UNVERIFIED, not VERIFIED.
4. **Never break the agent.** Collection is fire-and-forget and best-effort. rpt failing
   must never wedge a run. Integrity is preserved by recording the gap, not by blocking.
5. **Purity where it counts.** Risk scoring and verdict computation are pure functions.
   Same facts, same score, every time, testable with no repo and no git.
6. **The agent cannot clear itself.** Approval requires an interactive human.

## 5. Architecture

Strict one-way dependency. Nothing below points upward.

```
cli/  +  ui/ (ink)              surfaces, interchangeable
        |
        v
app/                            use cases: startRun, recordEvent, verifyRun,
        |                       assessRisk, approveRun, gateCommit, replayRun
        v
domain/   risk/                 pure. no filesystem, no git, no network
        ^
        |
store/  collectors/  verifiers/ the only impure modules
```

Directory layout:

```
src/
  cli/            argument parsing, command dispatch, exit codes
  ui/             Ink components and screens
  app/            use cases, one file per use case
  domain/         AgentRun, AgentEvent, RunFacts, Verdict, Policy, state machine
  risk/           RiskEngine, rule definitions, scoring
  store/          EventLog, RunIndex, snapshot refs
  collectors/     AgentAdapter interface, ClaudeCodeAdapter, TranscriptEnricher
  verifiers/      TestVerifier, DiffIntegrityVerifier, SecurityVerifier,
                  TestQualityVerifier, Worktree
  config/         config loading, defaults, validation
```

Module rules:
- `domain/` and `risk/` import nothing from the other directories.
- `ui/` imports only from `app/`. Replacing Ink with a web UI touches one directory.
- Only `store/` writes to `.rpt/`. Only `verifiers/Worktree` invokes git plumbing that
  creates refs or worktrees.

## 6. Event model

Every event:

```ts
type EventEnvelope<K extends EventKind, P> = {
  runId: RunId;
  seq: number;          // monotonic per run, defines order
  ts: string;           // ISO 8601, informational only
  source: "claude-code" | "rpt";
  kind: K;
  payload: P;
  checksum: string;     // sha256 of the serialized line, minus this field
};
```

Order is defined by `seq`, not `ts`. Hook delivery jitter cannot scramble history.

Event kinds in v1:

| Group | Kinds |
|---|---|
| Lifecycle | `RunStarted`, `AgentStopped`, `RunCommitted` |
| Agent activity | `ToolCallStarted`, `ToolCallCompleted`, `FileMutated`, `CommandStarted`, `CommandCompleted`, `PromptSubmitted` |
| Accounting | `ModelUsageRecorded` |
| Adjudication | `VerificationStarted`, `VerifierCompleted`, `RiskAssessed`, `ApprovalRequested`, `ApprovalGranted`, `ApprovalDenied` |
| Integrity | `GapRecorded` |

`GapRecorded` carries a reason and a count of events believed lost. Its presence in a
run's log permanently disqualifies that run from VERIFIED.

## 7. Run lifecycle

```
RUNNING -> ENDED -> VERIFYING -> { VERIFIED | FAILED | UNVERIFIED }
                                        |
                                        v
                              AWAITING_APPROVAL -> { APPROVED | REJECTED }
                                        |
                                        v
                                     RECORDED
```

- `RUNNING`: hooks are streaming events. Base state captured.
- `ENDED`: agent stopped. End state captured and sealed.
- `VERIFYING`: verifiers executing against a detached worktree.
- `VERIFIED`: every enabled verifier ran and passed, no gaps.
- `FAILED`: a verifier ran and failed.
- `UNVERIFIED`: a verifier could not run, or the log has gaps.
- `AWAITING_APPROVAL`: a human decision is required. Entered from any of the three
  verdicts, but for different reasons. A VERIFIED run enters only when its risk band
  demands approval. A FAILED or UNVERIFIED run always enters, regardless of score, because
  a commit on unproven work is itself the thing a human must accept.
- `RECORDED`: commit landed, git note attached.

Approving a FAILED or UNVERIFIED run is an override. The attestation records it as such,
so the note distinguishes "verified then approved" from "approved despite failure".

Illegal transitions throw. The state machine is a pure function in `domain/`.

## 8. Run boundaries and snapshotting

Most Claude Code work is uncommitted when a session ends, so a design anchored on commits
would observe nothing. rpt therefore snapshots working tree state, not just HEAD.

At `RunStarted`, rpt records the base commit sha and builds a base snapshot. At
`AgentStopped`, it builds an end snapshot.

Snapshot procedure, which never touches the user's index or working tree:

1. Set `GIT_INDEX_FILE` to a temporary index path.
2. `git add -A` against that temporary index.
3. `git write-tree` to get a tree object.
4. `git commit-tree` with the base commit as parent to get a snapshot commit.
5. Store the snapshot sha under `refs/rpt/runs/<runId>/{base,end}`.

Verification then adds a detached worktree at the end snapshot ref. A concurrent agent
editing files cannot race the verification run. Worktrees are removed and refs pruned on
run finalization, with a `rpt doctor` command to clean orphans.

## 9. Claimed versus observed

Claims come from events. Observations come from rpt executing tools.

| Claim | Observation |
|---|---|
| `FileMutated` events | `git diff --name-status base..end` |
| `CommandCompleted` reporting a passing test run | rpt reruns the test command in the worktree |
| Agent prose about scope | not an input at all |

The verdict is computed exclusively from observations. Claims are used for exactly one
purpose beyond display: the diff integrity verifier compares them against observations to
detect undeclared changes.

## 10. Verifiers

Interface:

```ts
type VerifierResult = {
  id: string;
  status: "passed" | "failed" | "skipped";
  reason?: string;          // required when skipped or failed
  facts: Record<string, unknown>;  // feeds RunFacts
};

interface Verifier {
  id: string;
  run(ctx: RunContext): Promise<VerifierResult>;
}
```

`RunContext` carries the worktree path, base and end snapshot shas, the resolved config,
and the run's claims. Verifiers receive no ambient access to the user's working tree.

**TestVerifier.** Resolves the test command from config, else detects it from
`package.json` scripts, `Makefile`, `pyproject.toml`, `go.mod`, or `Cargo.toml`. Runs it
in the worktree. Parses pass and fail counts where the reporter allows, otherwise relies
on exit code and records counts as unknown. Skips with a reason when no command can be
resolved.

**DiffIntegrityVerifier.** Compares claimed mutated paths against the observed diff.
Fails on undeclared file additions or modifications. Flags lockfile and manifest changes
separately, since dependency changes carry their own risk weight. Never depends on a test
runner, so it is the one verifier that essentially always runs.

**SecurityVerifier.** Two checks. A secret scan over the diff hunks using entropy plus
pattern rules, with `gitleaks` used when present on PATH and the built-in scanner as
fallback. A dependency audit over changed manifests using the ecosystem's own audit
command. High severity findings fail the run. The audit skips rather than fails when
offline.

**TestQualityVerifier.** Determines whether tests added in this run execute the lines the
run changed. Requires coverage tooling. When coverage is unavailable it returns `skipped`
with a reason, which downgrades the run to UNVERIFIED rather than failing it. Configurable
to warn-only for repos without coverage.

## 11. Risk engine

Pure function:

```ts
assessRisk(facts: RunFacts, policy: Policy): RiskAssessment
```

`RunFacts` is assembled by `app/` from observations only:

```ts
type RunFacts = {
  pathsChanged: string[];
  fileCount: number;
  linesAdded: number;
  linesRemoved: number;
  sensitiveMatches: { category: string; paths: string[] }[];
  dependencyChanged: boolean;
  testsAdded: number;
  testResult: "passed" | "failed" | "unknown";
  scanResult: "clean" | "findings" | "skipped";
  changeCoverage: number | null;   // 0..1, null when unavailable
  undeclaredFiles: string[];
};
```

Rules are declarative and configurable:

```ts
type RiskRule = {
  id: string;
  label: string;          // shown in the itemized breakdown
  points: number;         // may be negative
  when: (facts: RunFacts) => boolean;
};
```

Shipped defaults:

| Rule id | Label | Points |
|---|---|---|
| `sensitive-auth` | Authentication or authorization paths modified | +25 |
| `sensitive-database` | Database access or migration paths modified | +20 |
| `sensitive-infra` | Infrastructure or deployment paths modified | +20 |
| `dependency-changed` | Production dependency changed | +20 |
| `undeclared-files` | Undeclared files in diff | +15 |
| `files-changed-bulk` | More than 10 files changed | +10 |
| `files-changed-count` | Files changed, one point each, capped at 10 | +1 each |
| `scan-findings` | Security scan produced findings below high severity | +25 |
| `scan-skipped` | Security scan skipped | +10 |
| `tests-unknown-or-failing` | Test result unknown or failing | +15 |
| `tests-added` | Regression tests added | -10 |
| `tests-passed` | All tests passed | -5 |
| `scan-clean` | Security scan clean | -10 |
| `coverage-high` | Change coverage above 0.8 | -5 |

High severity scan findings do not score. They fail the SecurityVerifier outright, which
sends the run to FAILED. `scan-findings` covers findings below that bar.

Config overrides address rules by id. An override for an unknown id is a config error.

Score is the clamped sum over 0 to 100. The assessment carries every contributing rule
with its label and points, so the number is always explainable.

Bands:

```
0-20    LOW       auto
21-50   MEDIUM    review recommended
51-80   HIGH      human approval required
81-100  CRITICAL  commit blocked, no approval path
```

Sensitive path categories are glob lists in config, with defaults covering common auth,
database, migration, infrastructure, CI and secret-file layouts.

## 12. Policy, gate and approval

`rpt init` installs two git hooks, chaining to any existing hook rather than overwriting.

**pre-commit** runs `rpt gate`. The active run is the most recent run for this repo that
has reached ENDED and has not yet reached RECORDED. When there is no such run, the gate
exits zero and stays out of the way, so rpt never blocks hand-written commits.

The gate verifies the run if it has not been verified, computes risk, and exits nonzero
when a human decision is required and none has been recorded. Specifically it blocks a
VERIFIED run whose band is HIGH, any FAILED or UNVERIFIED run, and any CRITICAL run.
CRITICAL cannot be cleared by approval at all.

Gate output on block:

```
rpt: commit blocked

  run 1842  fix authentication timeout
  risk 67 HIGH  approval threshold 51
  verdict VERIFIED

  approve with:  rpt approve 1842
```

**post-commit** attaches the attestation note and moves the run to RECORDED.

**Approval is human-only.** `rpt approve` and `rpt reject` require an interactive TTY and
refuse to run when stdin is not a terminal or when the rpt agent-context environment
marker is set. Neither verb is exposed through the slash command plugin. Without this
constraint an agent could clear its own run and the accountability layer would be
decorative.

**Bypass** is possible via `RPT_BYPASS=1`. It does not silence rpt. The gate records an
event capturing the bypass, the user, and the risk score at the time, so a bypassed
commit remains visible in the record.

## 13. Attestation

On successful commit, rpt attaches a compact summary as a git note under `refs/notes/rpt`.

```
run 1842 | fix authentication timeout
verdict VERIFIED | risk 67 HIGH
tests 184 passed 0 failed | files 7 | cost 1.84 USD
approved by klyne at 2026-09-09T14:22:31Z
digest sha256:8c1f...

A run that needed no approval carries a `cleared automatically` line in place of the
approval line. An override carries `approved despite FAILED by klyne`.
```

The digest covers the full event log, so a note can be checked against the local log to
detect tampering. The full log stays in `.rpt/`, gitignored. The note travels with the
repo and is reviewable in a pull request.

## 14. Cost accounting

Model and token usage come from the Claude Code transcript at
`~/.claude/projects/<slug>/<sessionId>.jsonl`. Each assistant message carries the model
plus input, output, cache-creation and cache-read token counts. rpt emits one
`ModelUsageRecorded` event per assistant message and prices it against a versioned price
table keyed by model id, with separate rates per cache tier.

The price table is data, not code, and carries its own version. A run's cost record stores
the table version used, so historical runs remain reproducible when prices change. An
unknown model id yields a cost of null and a visible warning rather than a wrong number.

## 15. Storage

```
.rpt/
  config.json            resolved config snapshot per run creation
  runs/
    1842/
      meta.json          run id, task, repo, base and end sha, state
      events.jsonl       append-only, one envelope per line
      verdict.json       verifier results and final verdict
      risk.json          assessment with itemized rules
  index.jsonl            append-only run index for fast listing
  daemon.sock            unix socket
```

`.rpt/` is added to `.gitignore` by `rpt init`.

The event log is append-only with a per-line checksum. On read, a trailing partial line is
skipped and a `GapRecorded` is synthesized in memory, so a crash mid-write degrades the
run's verdict rather than corrupting the reader.

Run ids are per-repo monotonic integers allocated from `index.jsonl`.

## 16. Configuration

`rpt.config.json` at repo root, validated on load with a schema. Unknown keys are an
error, not a warning.

```json
{
  "testCommand": "pnpm test",
  "coverageCommand": "pnpm test -- --coverage",
  "sensitivePaths": {
    "auth": ["src/auth/**", "**/*auth*.ts"],
    "database": ["src/db/**", "**/migrations/**"],
    "infra": ["infra/**", ".github/workflows/**", "Dockerfile"]
  },
  "thresholds": { "review": 21, "approval": 51, "block": 81 },
  "rules": { "overrides": { "files-changed-bulk": 15 } },
  "verifiers": { "testQuality": "warn" }
}
```

## 17. Surfaces

One engine, three renderers. Format is chosen by `--format`, defaulting to `tui` on a TTY
and `text` otherwise.

Commands:

```
rpt init                 install hooks, gitignore entry, config scaffold
rpt status               active run summary
rpt runs                 list runs
rpt run <id>             run detail
rpt events <id>          raw event timeline
rpt diff <id>            observed diff
rpt risk <id>            itemized risk assessment
rpt verify <id>          run or rerun verification
rpt approve <id>         human approval, TTY required
rpt reject <id>          human rejection, TTY required
rpt replay <id>          reconstructed session timeline
rpt gate                 pre-commit gate, exit code is the contract
rpt doctor               diagnose hooks, daemon, orphaned worktrees and refs
```

`--format=agent` emits compact plain text under a token budget, suitable for injection
into an agent's context.

Ink screens: Dashboard, RunDetail, Events, Diff, Risk, Approve. Keys `v` events, `d` diff,
`t` tests, `r` risk, `a` approve, `q` quit.

Slash plugin exposes read-only verbs: `/rpt:status`, `/rpt:verify`, `/rpt:risk`,
`/rpt:diff`. Each shells to the binary with the agent format.

## 18. Adapter seam

```ts
interface AgentAdapter {
  id: string;
  install(repo: string): Promise<void>;      // write hook config
  uninstall(repo: string): Promise<void>;
  normalize(raw: unknown): AgentEvent[];     // agent payload -> domain events
  enrich(run: AgentRun): Promise<AgentEvent[]>;  // transcript backfill
}
```

v1 ships `ClaudeCodeAdapter`. Codex and Gemini adapters are out of scope until the engine
has been proven against one real agent.

## 19. Error handling and integrity

- Hooks write to the unix socket with a short timeout, fire and forget. A failed write
  never blocks the agent.
- When the daemon is unreachable, the hook appends directly to the log under a file lock.
- When both paths fail, the hook exits zero and the next successful write records a
  `GapRecorded`.
- A verifier that throws is captured as `status: "skipped"` with the error as its reason.
- No error is swallowed. Every catch either records an event or rethrows.
- Errors surfaced to the user carry the run id and the remedial command.

## 20. Testing strategy

TDD throughout. Coverage floor 80 percent.

- **domain and risk**: table-driven unit tests, golden score fixtures. No I/O.
- **store**: round trip, concurrent append under lock, torn-write recovery.
- **verifiers**: integration tests against fixture repos built in temp dirs, one fixture
  per ecosystem for command detection.
- **collectors**: replay of recorded Claude Code hook payload fixtures and a truncated
  transcript fixture.
- **gate**: exit code contract tested per risk band, including bypass recording.
- **e2e**: a scripted fake agent emits hook payloads against a fixture repo. Asserts a
  clean run reaches VERIFIED and lands a note. Asserts a HIGH run blocks at the gate and
  unblocks after approval.
- **ui**: ink-testing-library snapshots per screen.

## 21. Milestones

1. `domain/`, `store/`, replay. Event log, state machine, run index.
2. `collectors/ClaudeCodeAdapter`, daemon, `rpt init`, `rpt status`.
3. `verifiers/` with worktree isolation. All four verifiers.
4. `risk/`, policy, `rpt gate`, git note attestation, approval flow.
5. Ink TUI, all six screens.
6. Slash command plugin, `rpt doctor`, docs, packaging.

## 22. Packaging

Published as `@klyne/rpt`. The unscoped npm name `rpt` is taken. The binary is `rpt`.
Node with pnpm, TypeScript throughout.

## 23. Implementation discipline

All implementation is written by the `swe:clean-code` agent under the full Clean Code
rule set. Every diff is reviewed by the `swe:swe` agent before a milestone is considered
complete. Violations are fixed before moving on, not logged as debt.
