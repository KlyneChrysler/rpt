# Claude Code hook payload fixtures

Captured from a real Claude Code session, not written from memory.

- Claude Code version: 2.1.266
- Captured: 2026-09-09
- Method: a recorder hook registered for SessionStart, UserPromptSubmit, PreToolUse,
  PostToolUse and Stop in a scratch project, driven by one headless `claude -p` run
  that read a file, wrote a file, and ran a shell command.

Sanitisation applied: absolute paths rewritten to `/fixture/repo`, `session_id` set to
`fixture-session`, `transcript_path` fixed, prompt text and the final assistant message
replaced with placeholders. No other field was altered, so field names and nesting are
exactly what Claude Code emits.

If a field the adapter reads is absent from every fixture here, the adapter must not
read it. Re-capture with the same method rather than editing these files by hand.
