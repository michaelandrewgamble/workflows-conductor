<h1 align="center">Workflows Conductor</h1>

<p align="center">Mission control for Claude Code dynamic workflows — live agent observability, cross-project run history, and save/re-run, on every surface Claude Code runs.</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-4f46e5" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/runtime%20deps-zero-4f46e5" alt="Zero runtime dependencies" />
  <img src="https://img.shields.io/badge/monitoring%20cost-0%20tokens-4f46e5" alt="Zero-token monitoring" />
  <img src="https://img.shields.io/badge/works%20in-Cursor%20·%20VS%20Code%20·%20CLI-4f46e5" alt="Works in Cursor, VS Code, and the CLI" />
</p>

<!-- TODO: docs/dashboard.png — dashboard mid-run with agent sub-rows expanded and the tail panel open -->

---

**Workflows Conductor** brings the missing `/workflows` experience to the Claude Code **VS Code / Cursor extension** — and goes past it. Claude Code's dynamic workflows fan work out across up to 16 concurrent subagents, but the extension has no way to watch them ([anthropics/claude-code#72292](https://github.com/anthropics/claude-code/issues/72292)); the interactive monitor exists only in the terminal TUI and the Desktop tasks pane. Conductor closes that gap with a **live dashboard** and a set of **`/conductor:*` slash commands**, built on a single architectural bet: *workflow state is just files*. Every run writes records, journals, and per-agent transcripts under `~/.claude/projects/` — so a careful reader can observe everything, from any surface, whether or not the session that launched it is even alive, **without spending a single model token**.

Because it reads the disk rather than any one session, Conductor sees runs started from the **CLI, the Desktop app, and the extension at once** — something no built-in surface offers, including the Desktop tasks pane (current-session only).

## Table of contents

- [Features](#features)
- [Install](#install)
- [Commands](#commands)
- [The dashboard](#the-dashboard)
- [Architecture](#architecture)
- [Capability matrix](#capability-matrix)
- [Security model](#security-model)
- [Token cost](#token-cost)
- [Requirements & compatibility](#requirements--compatibility)
- [Known limitations](#known-limitations)
- [Development](#development)

## Features

- **Live agent observability** — active runs float to the top of a unified table with per-agent sub-rows: state with pulse/stalled detection, elapsed time, live token burn, and the model each agent is *actually* running (read from its transcript, not its config). Click an agent for a chat-style panel: pinned identity header, streaming activity feed that follows the newest event, and the agent's full goal pinned as the footer.
- **Cross-project, cross-surface history** — every run from every project and every surface in one sortable, filterable, project-grouped table, with expandable per-agent detail (tokens, model, duration) for finished runs too.
- **Save & re-run** — extract any run's orchestration script (even a killed run's — it's inlined in the run record) into a reusable `/name` slash command, or relaunch it fresh with `/conductor:rerun`.
- **IDE-native** — follows your Cursor/VS Code color theme live (it watches `settings.json`, not the OS), opens inside the IDE's Simple Browser via a one-keystroke bridge, and the dashboard URL/token stay stable across restarts and upgrades so a pinned tab keeps working forever.
- **Zero-token monitoring, zero dependencies** — the dashboard, MCP server, reader, and hooks never call a model; the entire plugin is dependency-free Node (stdio MCP server and HTTP+SSE dashboard included).
- **Honest under uncertainty** — the CLI persists run state only at terminal status, so live-state is heuristic by nature; Conductor says so (`live?`, `stalled?`, `running (resumed after killed)`) instead of guessing, and every claim degrades gracefully when the undocumented on-disk format shifts.

## Install

From any terminal (the `/plugin` command isn't available inside the extension chat; installs are user-scoped and shared across all surfaces):

```sh
claude plugin marketplace add michaelandrewgamble/workflows-conductor
claude plugin install conductor@workflows-conductor
```

Start a new Claude Code session, then:

```
/conductor:dashboard
```

On macOS + Cursor this opens the dashboard **inside the IDE** (it installs a `ctrl+alt+d` → Simple Browser keybinding on first use and presses it for you); everywhere else it prints the stable localhost URL.

## Commands

| Command | What it does |
|---|---|
| `/conductor:status [--all] [--limit N] [runId]` | Run table in chat — current project by default, `--all` for every project; drill into a run's agents or script by ID |
| `/conductor:dashboard [stop] [--external]` | Ensure the live dashboard is running and open it in-IDE (`--external` for your browser) |
| `/conductor:save <runId> <name> [--user] [--force]` | Save a run's script as a reusable `/name` workflow — project scope (git-shared) or `--user` (personal) |
| `/conductor:rerun <runId>` | Relaunch a past run's script as a fresh run in the current session |

All commands are also available to Claude as typed MCP tools (`list_runs`, `get_run`, `get_agents`, `get_script`, `save_workflow`, `export_script`, `start_dashboard`, `stop_dashboard`), with response projection that keeps large artifacts (scripts, transcripts) out of your chat context.

## The dashboard

One table, everything in it:

- **Active runs** carry a pulse dot, ticking duration, and live token sums, with agent sub-rows always expanded; **finished runs** expand on demand (▸ or row click) into the same column-aligned sub-rows. Live and historical agents render through one code path, so the views can never drift apart.
- **ⓘ** on any run opens the run panel (goal, result preview, totals); clicking an **agent** opens its live transcript feed — newest at the bottom, auto-following unless you scroll up to read, exactly like the chat stream it is.
- **Sort** any column, **filter** by text or all/active/finished, **group by project** (live runs are never hidden inside collapsed groups).
- Updates arrive by **filesystem events** (one recursive watch + SSE), not polling loops in your browser — and a run finishing simply changes its row's status in place.

The dashboard is a single detached process: it survives the sessions that spawn it, self-heals orphaned instances on the port, self-stops after 30 idle minutes, and revives at the same URL on the next `/conductor:dashboard`.

## Architecture

```
~/.claude/projects/**            (run records · journals · agent transcripts)
        │  pure file reads
        ▼
   server/reader.js              drift-tolerant reader — the core
        ├─► server/index.js      stdio MCP server → /conductor:* skills → chat
        ├─► server/dashboard.js  detached HTTP+SSE dashboard → browser / Simple Browser
        └─► saveAsWorkflow       the one write path → .claude/workflows/<name>.js
   hooks/hooks.json              SubagentStart/Stop → event log (live-status enrichment)
```

Design principles, in the order they were forced on us by evidence (see [ARCHITECTURE.md](ARCHITECTURE.md) for the full design and [SPIKES.md](SPIKES.md) for the verified platform facts):

1. **Observer, not controller.** Run control (pause/stop/restart) is ownership-bound to the process that launched a run; no external tool can reach it. Conductor observes everything and controls nothing — and tells you where control actually lives (the owning chat, or `/workflows` in a terminal).
2. **The on-disk format is undocumented and *known* to vary** — across CLI versions on a single machine, and across runs. The reader treats status as an open enum, tolerates torn writes at every layer (records are written mid-read; journals are appended mid-read), tags every record with a compat level, and never lets one bad file poison a listing.
3. **Runs are not where you expect.** A run's record and its script can land in *different* project directories (cwd changes mid-session); killed runs resume in-place under the same ID with a stale terminal record lying next to live transcripts. The reader joins across all of it.
4. **Chat context is a budget.** Skills consume compact projections; scripts and transcripts travel as file paths, never inlined. Monitoring belongs on the dashboard, where it costs nothing.

## Capability matrix

Honest accounting against the built-in surfaces:

| Capability | CLI `/workflows` TUI | Desktop tasks pane | **Conductor** |
|---|---|---|---|
| Inspect runs, phases, agents | ✅ current session | ✅ current session | ✅ **all projects, all surfaces, full history** |
| Per-agent model / live tokens / goal | ❌ | ❌ | ✅ |
| Live transcript feed per agent | partial (detail view) | ✅ | ✅ chat-style, follows the tail |
| Save run as slash command | ✅ (`s`) | ❌ | ✅ |
| Re-run a past/killed run | ❌ | ❌ | ✅ |
| Pause / resume (cached) | ✅ (`p`) | ❌ | ❌ *owning session only — ask its Claude* |
| Stop / restart agents | ✅ (`x`/`r`) | stop only | ❌ *same* |
| Works in the VS Code/Cursor extension | ❌ | ❌ | ✅ |

The ❌s in the last column are physics, not roadmap: journal-replay resume and process control exist only inside the session that owns the run. Conductor's job is to make everything observable and everything recoverable (save + re-run), and to be honest about the boundary.

## Security model

Agent transcripts can contain secrets, so the dashboard is treated as sensitive:

- Binds to `127.0.0.1` only; every route (including SSE) requires a bearer token; `Host`/`Origin` are validated against DNS-rebinding.
- The token file is `0600` in a `0700` directory; tokens are stable across restarts *by design* (rotating them silently killed pinned tabs).
- No client-supplied path ever reaches the filesystem: transcript lookups accept only regex-validated run/agent IDs and resolve paths exclusively from directory listings.
- Every interpolation in the page goes through one escaping function; transcript-derived content (tool inputs, text) is assumed hostile.
- Adversarially security-reviewed (path traversal, XSS, rebinding, DoS) during development; findings and fixes are in the commit history.

## Token cost

Passive overhead is ~200 tokens per session (the skill descriptions). Everything continuous — dashboard, file watching, hooks — runs entirely off-model: **watching your workflows costs zero tokens**. You pay only when you invoke a skill, and projections keep those calls in the hundreds of tokens. In practice Conductor is token-negative: every dashboard glance replaces a "what's running?" model turn.

## Requirements & compatibility

- **Claude Code CLI ≥ 2.1.154** (dynamic workflows) — developed and tested against 2.1.18x–2.1.19x
- **Node ≥ 18** on PATH (the MCP server and dashboard are plain Node, zero packages)
- `jq` on PATH (used by the event-log hook)
- macOS tested end-to-end (incl. the in-IDE open bridge); the dashboard and skills are platform-neutral, Windows/Linux in-IDE opening falls back to the printed URL
- Works in the Cursor and VS Code extensions, the terminal CLI, and alongside the Desktop app

## Known limitations

- **Live state is heuristic.** The CLI writes run records only at terminal status; between launch and completion, liveness is inferred from journal/transcript activity and hook events. Conductor labels these `live?` / `stalled?` rather than asserting.
- **Queue depth is invisible.** Agents queued beyond the concurrency cap exist only in the workflow runtime's memory; the phase plan parsed from the script is the best available proxy.
- **The on-disk format is Anthropic-internal.** A CLI update can change it; the reader's compat tagging will flag unrecognized records rather than break, but expect a patch release when that happens.
- Upstream asks tracked in [ARCHITECTURE.md §2.6](ARCHITECTURE.md): `/workflows` in the extension, an external run-control API, persisted live state, and a plugin UI surface.

## Development

```sh
git clone https://github.com/michaelandrewgamble/workflows-conductor
cd workflows-conductor
node --test server/reader.test.js     # 18 tests, synthetic fixtures modeling observed schema generations
claude plugin validate .
claude plugin marketplace add .       # install your working copy
```

The repo doubles as its own marketplace. Layout: `server/` (reader + MCP + dashboard, one file each), `skills/` (the slash commands), `hooks/` (the event logger), `.claude-plugin/` (manifest + marketplace). Plugin updates are version-gated — bump `version` in `plugin.json` or your installed copy won't refresh.

Issues and PRs welcome. If a CLI update breaks the reader, an issue with one `wf_*.json` (redact the `script`/`result` fields) is a complete bug report.

## License

[MIT](./LICENSE) © Michael Gamble
