---
description: Open the Workflows Conductor live dashboard — a localhost view of all Claude Code dynamic workflow runs across projects, with live per-agent updates. Use when the user wants to watch workflow runs, see a workflow dashboard, or monitor runs outside chat.
argument-hint: "[stop] [--external]"
allowed-tools: mcp__plugin_conductor_conductor__start_dashboard mcp__plugin_conductor_conductor__stop_dashboard
---

# /conductor:dashboard — live run dashboard

1. Argument `stop` → call the conductor `stop_dashboard` tool and report the result.
2. Otherwise call `start_dashboard {open: false}` (`{open: true}` only if the user passed `--external` or asked for their browser). It is idempotent — safe to call when already running.
3. Present the returned URL and the in-IDE flow, which is the intended experience:
   - **Inside Cursor/VS Code (recommended)**: open the command palette (Cmd+Shift+P) → "Simple Browser: Show" → paste the URL (or paste it into Cursor's built-in browser tab). **The URL and token are stable across dashboard restarts and plugin updates**, so this is a one-time setup — the tab keeps working; keep it pinned next to the editor.
   - The URL is also clickable for an external browser if preferred.
4. Mention: it updates live as runs progress (per-agent sub-rows, click for the live transcript feed) and self-stops after 30 idle minutes — the next `/conductor:dashboard` (or any status check) revives it at the same URL.
5. On `running: false`: report the reason (most likely port 7423 occupied by a non-conductor process) and suggest `stop` first or checking what holds the port.

Honest limitations to convey if asked: the panel cannot be embedded in the extension UI itself (plugins have no webview surface — upstream ask); live/in-flight state is heuristic until the CLI writes the terminal record; pause/stop/restart of runs is not possible from outside the owning session — use `/workflows` in a terminal for that.
