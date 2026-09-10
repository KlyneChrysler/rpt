# rpt

**Your AI agent reports its own results. rpt checks them.**

"I fixed the bug, 184 tests pass, 7 files changed." That sentence was written by
the same system that made the change. Nothing outside the agent confirms it.

rpt watches a Claude Code session from the outside. It asks git what actually
changed, runs your test suite itself, scores the risk, and stops the commit when
a person should look. The verdict is attached to the commit as a git note, so it
travels with the code.

What the agent claims is recorded but never trusted. The claims have exactly one
job: revealing the files the agent changed and did not mention.

---

## It stops a commit that needs you

This is `git commit`. There is no new command to run.

![rpt refusing a commit that needs human approval](docs/media/gate.png)

## It shows its work

Every rule that moved the score, and by how much.

![The itemised risk breakdown, showing each rule and its weight](docs/media/risk.png)

## It leaves a receipt on the commit

A git note, reviewable in a pull request. It records whether a person approved,
whether the gate was bypassed, or whether nobody was needed.

![The attestation note attached to a commit](docs/media/receipt.png)

## It gives you a console

`rpt` on a terminal. Enter opens a run, then `v` events, `d` diff, `t` tests,
`r` risk, `a` approve.

![The rpt dashboard listing runs with state, risk and cost](docs/media/dashboard.png)

![Run detail, showing duration, cost, files, tests and every check](docs/media/run-detail.png)

---

## Use it

Requires Node 22 and a git repository.

```bash
git clone https://github.com/KlyneChrysler/rpt.git
cd rpt && pnpm install && pnpm build && npm link
```

Then once per repository you want watched:

```bash
cd ~/your-project
rpt init
```

Open `rpt.config.json` and give it your test command. This is the setting that
decides how much rpt can tell you:

```json
{
  "testCommand": "pnpm test",
  "coverageCommand": "pnpm test -- --coverage"
}
```

Now use Claude Code as you did before. rpt records the session, verifies it when
you commit, and stays quiet unless something needs you.

```bash
rpt                  # the console
rpt runs             # every run
rpt risk 3           # why a run scored what it did
rpt diff 3           # what rpt observed, not what the agent claimed
rpt approve 3        # human only, terminal required
rpt doctor           # when something feels wrong
git log --notes=rpt  # the receipts
```

## Slash commands in Claude Code

Read-only verbs your agent can call on itself: `/rpt:status`, `/rpt:verify`,
`/rpt:risk`, `/rpt:diff`.

```bash
claude plugin marketplace add KlyneChrysler/rpt
claude plugin install rpt@rpt
```

There is no `/rpt:approve`. An agent that could clear its own run would make the
whole thing decorative.

## Two things to know up front

**A skip is not a pass.** A check that could not run means rpt does not know,
and not knowing sends the decision to you. Without a `coverageCommand` the
coverage check skips and every commit will ask for approval. Set one, or set
`"verifiers": { "testQuality": "off" }` to drop that check from the verdict.

**The agent cannot clear itself.** `rpt approve` refuses inside a Claude Code
session, requires a terminal, and asks you to type a phrase naming the run, the
verdict and the risk level. The slash command plugin exposes reads only.

| Score | Band | What happens |
|---|---|---|
| 0-20 | LOW | commits |
| 21-50 | MEDIUM | commits, review suggested |
| 51-80 | HIGH | needs your approval |
| 81-100 | CRITICAL | blocked, no approval path |

`RPT_BYPASS=1 git commit` skips the gate for everything except CRITICAL. The
receipt on that commit then reads `BYPASSED`.

## More

- [Using rpt](docs/usage.md) — every command, what gets recorded, how to recover
- [What rpt does not establish](docs/limits.md) — read before trusting a green verdict
- [Threat model](docs/threat-model.md) — what it defends against, and what it does not

MIT.
