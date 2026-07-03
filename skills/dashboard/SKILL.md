---
description: Open the Workflows Conductor live dashboard — a localhost browser view of all Claude Code dynamic workflow runs across projects, with live updates. Use when the user wants to watch workflow runs, see a workflow dashboard, or monitor runs outside chat.
argument-hint: "[stop]"
allowed-tools: mcp__plugin_conductor_conductor__start_dashboard mcp__plugin_conductor_conductor__stop_dashboard
---

# /conductor:dashboard — live run dashboard in the browser

1. Argument `stop` → call the conductor `stop_dashboard` tool and report the result.
2. Otherwise call `start_dashboard {open: true}`. It is idempotent — safe to call when already running.
3. On success: the browser opens automatically; also print the returned URL as a clickable link in case it didn't. Mention that the URL contains the auth token, the dashboard updates live as runs progress, and it self-stops after 30 idle minutes.
4. On `running: false`: report the reason (most likely port 7423 occupied by a non-conductor process) and suggest `stop` first or checking what holds the port.

Honest limitations to convey if asked: live/in-flight rows are heuristic (the CLI persists run records only at terminal state); pause/stop/restart of runs is not possible from outside the owning session — use `/workflows` in a terminal for that.
