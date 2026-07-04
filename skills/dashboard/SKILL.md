---
description: Open the Workflows Conductor live dashboard — a localhost view of all Claude Code dynamic workflow runs across projects, with live per-agent updates. Use when the user wants to watch workflow runs, see a workflow dashboard, or monitor runs outside chat.
argument-hint: "[stop] [--external]"
allowed-tools: mcp__plugin_conductor_conductor__start_dashboard mcp__plugin_conductor_conductor__stop_dashboard Bash(osascript *) Read Edit
---

# /conductor:dashboard — live run dashboard, opened inside the IDE

1. Argument `stop` → call the conductor `stop_dashboard` tool and report the result.
2. Otherwise call `start_dashboard {open: false}` (`{open: true}` only if the user passed `--external`). Idempotent; the returned URL/token are stable across restarts.
3. **Auto-open inside Cursor (macOS)** — the in-IDE open works by pressing a keybinding that invokes `simpleBrowser.show` with the dashboard URL:
   a. Check `~/Library/Application Support/Cursor/User/keybindings.json` contains a `simpleBrowser.show` binding whose `args` equals the URL returned in step 2. If missing or stale, add/update it (key `ctrl+alt+d`, preserve other entries and the JSONC comment style; mention a Cursor window reload is needed the first time a binding is added).
   b. Send the keystroke: `osascript -e 'tell application "Cursor" to activate' -e 'delay 0.3' -e 'tell application "System Events" to key code 2 using {control down, option down}'`
   c. If osascript errors with an assistive-access message: tell the user to grant Accessibility permission (System Settings → Privacy & Security → Accessibility) or just press ctrl+alt+d themselves.
4. Always end with a markdown link as the backup, exactly in this form: `**[View Dashboard](<url>)**` — and remind: ctrl+alt+d reopens it in-IDE anytime; the dashboard self-stops after 30 idle minutes and any `/conductor:dashboard` revives it at the same URL.
5. On `running: false`: report the reason (most likely port 7423 occupied by a non-conductor process) and suggest `stop` first or checking what holds the port.

Honest limitations to convey if asked: plugins cannot embed panels in the extension UI (upstream ask) — the keystroke bridge is the closest available; live/in-flight state is heuristic until the CLI writes the terminal record; pause/stop/restart of runs is not possible from outside the owning session — use `/workflows` in a terminal for that.
