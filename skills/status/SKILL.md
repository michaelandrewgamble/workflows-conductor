---
description: List Claude Code dynamic workflow runs (status, agents, tokens, duration) by reading run records from ~/.claude/projects. Use when the user asks about workflow runs, ultracode runs, run status, or anything /workflows would show.
argument-hint: "[--all] [--limit N] [runId]"
allowed-tools: Bash(node *) Read
---

# /conductor:status — list and inspect dynamic workflow runs

Backed by the plugin's reader library. Requires Node ≥ 18 on PATH.

## Context-cost rules (mandatory)

- Only ever consume the reader's JSON output — NEVER read `wf_*.json` run records directly (they embed 30–70 KB workflow scripts).
- Agent transcripts are returned as file paths; Read one only if the user asks about a specific agent, and only with a line limit.
- Render at most the requested row limit; state how many were omitted.

## Procedure

1. List runs (default: current project, limit 10; `--all` for every project):

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" list --cwd "$PWD" --limit 10
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" list --cwd "$PWD" --all --limit 20
```

2. If the user names a run ID, drill down:

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" get <runId>       # metadata + result preview
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" agents <runId>    # per-agent state + transcript paths
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" script <runId>    # full script source (large — only on request)
```

3. Render a markdown table from `runs`: Run ID · Name · Status · Agents · Tokens · Duration · When · Expires. Interpretation rules:
   - `status` is a raw passthrough. If `statusRecognized` is false, render the value verbatim with an "(unrecognized status)" marker — do not guess what it means.
   - `compat` of `degraded`/`unknown-format`/`unreadable` → append a warning marker to that row and mention that its record was written in an unexpected format (possibly a newer CLI).
   - `liveCandidates` rows have no run record yet: render them in a separate short section as `live?` (recent activity) or `stale (interrupted?)`, with `lastActivity`. Note once that live-state is heuristic until the CLI writes the terminal record.
   - `expiresInDays` ≤ 5 → mark the row "expires soon" (sessions auto-delete after ~30 days).

4. Close with one line of totals from `totalRuns` / `projectCount` / `omitted`. If `runs` is empty and there are no live candidates: say no workflow runs were found and note that dynamic workflows require Claude Code CLI ≥ 2.1.154 (launch one with an `ultracode:` prompt).
