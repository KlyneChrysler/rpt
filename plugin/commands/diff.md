---
allowed-tools: Bash(rpt diff:*)
argument-hint: "[run id]"
description: Show the diff rpt observed for a run
---

Run `rpt diff $ARGUMENTS --format=agent` and report its output verbatim.

This is the diff rpt derived from git between the run's base and end snapshots. It is what changed, not what you reported changing.

This output is produced by rpt, independently of you. If it disagrees with what you believe you did, rpt's observation is the record. You cannot approve or clear a run.
