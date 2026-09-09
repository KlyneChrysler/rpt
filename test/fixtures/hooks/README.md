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

A second capture on the same day and version added the Edit and NotebookEdit tools,
after a review found the adapter was reading a notebook path no fixture proved.

Verified write tools: Write, Edit, NotebookEdit. MultiEdit does NOT exist in this build;
a session asked to use it reported the tool was unavailable, so nothing here verifies it.

Note what the Edit and NotebookEdit responses contain. Edit returns originalFile,
newString and oldString. NotebookEdit returns original_file, updated_file, old_source
and new_source. Field naming is inconsistent between tools, camelCase in one and
snake_case in the other, which is precisely why the response summary uses an allowlist
of known-safe fields rather than a denylist of known-bad ones. A denylist written
against the Write response alone would have leaked whole notebook and file contents
into the event log.

If a field the adapter reads is absent from every fixture here, the adapter must not
read it. Re-capture with the same method rather than editing these files by hand.
