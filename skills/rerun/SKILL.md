---
description: Re-run a Claude Code dynamic workflow from a past run's script — a fresh run, useful for killed/failed runs or repeating a job. Use when the user wants to rerun, relaunch, retry, or restart a workflow run.
argument-hint: "<runId>"
allowed-tools: mcp__plugin_conductor_conductor__export_script mcp__plugin_conductor_conductor__list_runs mcp__plugin_conductor_conductor__get_run
---

# /conductor:rerun — relaunch a run's script as a fresh workflow

1. If no runId was given, call the conductor `list_runs` tool and ask which run to re-run (killed/failed runs are the usual candidates — show compact rows).
2. Call the conductor `export_script` tool: `{runId}` → returns a `scriptPath`. Do NOT fetch the script source into context.
3. Invoke the **Workflow** tool with `{scriptPath: <the returned path>}`. This starts a fresh run — no cached agent results carry over, and it runs in this session.
4. Report the new run ID from the Workflow result. Suggest `/conductor:dashboard` to watch it live, and `/conductor:save <newRunId> <name>` if the user wants to keep it as a named command.

If the Workflow tool is not available in this session, fall back to saving it as a named workflow instead: use `/conductor:save <runId> <name>` and tell the user to invoke `/<name>`.

Honest limitation: this is a re-run, not a resume — journal-cached results from the original run are not reused (true resume only works inside the session that owns the original run).
