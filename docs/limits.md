# What rpt does not establish

A green verdict from rpt is a narrow claim, and this page states exactly how
narrow, so nobody reads more into it than it can carry.

- **rpt verifies that the tests the repository already has still pass.** It
  cannot tell you those tests are good, or that they cover the change.
- **Change coverage measures execution, not assertion.** A line can be covered
  by a test that asserts nothing about it.
- **The secret scanner matches shapes and entropy.** It will miss novel formats
  and will occasionally flag a random-looking constant that is not a secret.
- **The dependency audit is only as current as the ecosystem's advisory
  database.** A vulnerability published this morning is not in last week's
  database.
- **Risk scores are a configured heuristic, not a measurement.** The default
  weights are a starting point to tune per repository, and the same change
  scores differently under a different config.
- **A bypassed commit is recorded, not prevented.** `RPT_BYPASS=1` still lets
  the commit through. rpt raises the cost of skipping the gate; it does not
  make skipping it impossible.
- **rpt observes one agent, Claude Code.** A change made outside an observed
  run - by hand, by another tool, by another agent - is invisible to it.
- **A run's config snapshot is only as trustworthy as `rpt.config.json` was at
  the moment that run started.** A previous, already-approved run could have
  changed it. rpt detects a snapshot altered or deleted after the fact and
  scores the run under its own defaults instead, with a visible finding; it
  cannot detect a config that was already poisoned before the run began.
- **Healing an approval trusts the recorded event.** `rpt` re-checks the
  event's verdict name, its config fingerprint and the shape of its numbers,
  and requires the same human confirmation a fresh decision does. It cannot
  independently re-derive the risk level that event claims, because that
  assessment is not itself tamper-evident.
- **The attestation digest proves the note matches the local event log.** It
  does not prove the log itself was never tampered with by someone with write
  access to `.rpt/`.

- **Windows is tested, with two checks that do not run there.** CI runs the full
  suite on Linux, macOS and Windows. The test-command and dependency-audit
  suites hand POSIX shell fragments to a verifier that runs them through the
  system shell, and cmd.exe is not that shell, so those two are skipped on
  Windows. rpt itself uses the console device and a named pipe there rather than
  `/dev/tty` and a unix socket.
