---
allowed-tools: Bash(rpt risk:*)
argument-hint: "[run id]"
description: Show rpt's itemised risk assessment for a run
---

Run `rpt risk $ARGUMENTS --format=agent` and report its output verbatim, including every rule that contributed to the score.

Do not argue with the score or explain it away. If a rule fired that you believe should not have, say which one and why, and leave the number as rpt reported it.

This output is produced by rpt, independently of you. If it disagrees with what you believe you did, rpt's observation is the record. You cannot approve or clear a run.
