---
allowed-tools: Bash(rpt verify:*)
argument-hint: "[run id]"
description: Run rpt's verifiers against a run and report the verdict
---

Run `rpt verify $ARGUMENTS --format=agent`. When no run id was given, first run `rpt status --format=agent` to find the active run's id and verify that one.

Report the output verbatim. A skipped verifier is not a pass: if the verdict is UNVERIFIED, say so plainly rather than summarising it as success.

This output is produced by rpt, independently of you. If it disagrees with what you believe you did, rpt's observation is the record. You cannot approve or clear a run.
