---
description: List Claude Code dynamic workflow runs (status, agents, tokens, duration) by reading run records from ~/.claude/projects. Use when the user asks about workflow runs, ultracode runs, run status, or anything /workflows would show.
argument-hint: "[--all] [--limit N]"
allowed-tools: Bash(jq *) Bash(find *) Bash(ls *) Read Glob
---

# /conductor:status — list dynamic workflow runs

List workflow run records from disk. Default scope: runs belonging to the current project. `--all`: every project. `--limit N` (default 10): max rows.

## Context-cost rules (mandatory)

- NEVER read a whole `wf_*.json` into context — records embed the full workflow script (30–70 KB each). Always use the jq projection below.
- NEVER inline agent transcripts or the `result`/`script` fields.
- Cap output at the row limit; state how many were omitted.

## Procedure

1. Compute the current project's encoded dir name: the absolute cwd with every non-alphanumeric character replaced by `-` (e.g. `/Users/me/proj` → `-Users-me-proj`). Do NOT reverse-decode directory names — always forward-encode.

2. Collect run rows (terminal-state runs). For `--all`, glob every project; for default scope, note that a run belongs to the current project if its record OR its `scriptPath` field points under the encoded cwd (records can live in a different project dir than their script when the cwd changed mid-session):

```bash
# -name anchors the filename; -not -path excludes per-agent files under subagents/workflows/wf_*/
find ~/.claude/projects -name 'wf_*.json' -path '*/workflows/*' -not -path '*/subagents/*' -print0 2>/dev/null | \
  xargs -0 -I{} jq -r '[
    (.runId // "?"), (.workflowName // "?"), (.status // "unknown"),
    ((.agentCount // 0)|tostring), ((.totalTokens // 0)|tostring),
    (((.durationMs // 0)/1000)|round|tostring + "s"),
    (.timestamp // "?"), (.scriptPath // ""), input_filename
  ] | @tsv' {} 2>/dev/null
```

Treat jq failures on individual files as `unreadable` rows, never as a reason to abort the listing. Pass unknown `status` values through verbatim — do not normalize them.

3. Detect possibly-live/interrupted runs: run dirs under `*/subagents/workflows/wf_*/` that have NO matching `wf_<id>.json` record. Enumerate with `find ~/.claude/projects -type d -path '*/subagents/workflows/wf_*' 2>/dev/null` — never with shell globs (zsh errors on no matches). For each, report the run ID and the most recent mtime across its files as "last activity". Label these `live?` if the last activity is under 10 minutes old, otherwise `stale (interrupted?)` — the CLI only writes run records at terminal state, so liveness is a heuristic.

4. Sort by timestamp (newest first), apply the limit, and render a markdown table: Run ID · Name · Status · Agents · Tokens · Duration · When · Age. Compute Age from the timestamp; note that sessions are auto-deleted after ~30 days (`cleanupPeriodDays`), so include "expires soon" on runs older than 25 days.

5. Close with one line of totals (N runs across M projects, X omitted by limit) and, if any `live?`/`stale` rows exist, a note that live-state is heuristic until the run finishes.
