---
description: Save a Claude Code dynamic workflow run's script as a reusable slash-command workflow (the "s" action from the CLI /workflows panel). Use when the user wants to keep, save, or reuse a workflow run.
argument-hint: "<runId> <name> [--user] [--force]"
allowed-tools: mcp__conductor__save_workflow mcp__conductor__list_runs Bash(node *)
---

# /conductor:save — save a run as a reusable workflow

Saves the run's script so it can be invoked as `/<name>` in later sessions. Project scope (default) writes to the nearest `.claude/workflows/` (shared via git); `--user` writes to `~/.claude/workflows/` (personal).

## Procedure

1. If the user gave no runId, call the conductor `list_runs` tool first and ask which run to save (show compact rows only).
2. Call the conductor `save_workflow` tool: `{runId, name, scope: "project"|"user", cwd: <absolute project path>, force: <true only if --force>}`.
3. On `saved: false` with an "exists" reason: report the conflict and require an explicit `--force` from the user — never force on your own.
4. On success, report the target path, the `/​<name>` invocation, and the `note` field if present (meta.name mismatch). Remind the user the command becomes available in new sessions.
5. If the source run is older than ~25 days (`expiresInDays` ≤ 5 in list_runs), mention the save just rescued it from session cleanup.

Fallback if MCP tools are unavailable:

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" save <runId> <name> [--user] [--force] --cwd "$PWD"
```
