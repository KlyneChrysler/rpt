# rpt slash commands for Claude Code

Four read-only commands that let an agent read what rpt observed about its own
run: `/rpt:status`, `/rpt:verify`, `/rpt:risk`, `/rpt:diff`.

## What is deliberately not here

There is no `/rpt:approve` and no `/rpt:reject`, and there never will be.
Approval requires an interactive human at a terminal and refuses to run inside
a known agent context. An agent that could clear its own run would make the
whole accountability layer decorative, so the agent surface exposes reads only.

Nothing here sets `RPT_BYPASS` either. A commit can still be bypassed, but that
is a decision a person makes at their own shell, and rpt records it when they
do.

## Requirements

`rpt` must be on `PATH`, and the repository must have been initialised with
`rpt init`.

## Schema

The manifest and command frontmatter follow the Claude Code plugin format as
shipped in the official plugin marketplace (`.claude-plugin/plugin.json` with
`name`, `version`, `description`, `author`; commands as Markdown files with
`description`, `argument-hint` and `allowed-tools` frontmatter). Verified
against the installed marketplace plugins on 2026-09-10.

## Install

```
/plugin install <path-to-this-directory>
```
