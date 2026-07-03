# Workflows Conductor

A Claude Code plugin that brings dynamic-workflow run management to the VS Code / Cursor extension — the `/workflows` TUI and Desktop tasks-pane experience for surfaces that don't have it. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design and [SPIKES.md](SPIKES.md) for verified platform facts.

## Install (local, during development)

From any terminal (the `/plugin` slash command is not available inside the VS Code/Cursor extension chat — verified 2026-07-03; installs are user-scoped and shared across surfaces):

```
claude plugin marketplace add /Users/michaelgamble/GitHub/workflows-conductor
claude plugin install conductor@workflows-conductor
```

Then start a new session (hooks and MCP components load at session start; `/reload-plugins` may suffice for skill-only changes).

## Commands

| Command | Status | What it does |
|---|---|---|
| `/conductor:status [--all] [--limit N]` | M0 preview | List workflow runs (current project or all), with heuristic live/interrupted detection |
| `/conductor:inspect <runId>` | planned (M2) | Per-agent drill-down for one run |
| `/conductor:save <runId> <name>` | planned (M3) | Save a run's script as a reusable `/​<name>` workflow |
| `/conductor:dashboard` | planned (M4) | Live browser dashboard (auto-opens) |
| `/conductor:rerun <runId>` | planned (M5) | Relaunch a run's script as a fresh run |

## What it can and cannot do

Reads workflow state directly from `~/.claude/projects/` — works for runs started from the CLI, Desktop, or the extension. It cannot pause, stop, or restart runs: that requires owning the run's process. For run control of terminal-launched runs, use `/workflows` in the terminal CLI.

## Requirements

- Claude Code CLI ≥ 2.1.154 (dynamic workflows)
- `jq` on PATH (used by the status skill and event hooks)
