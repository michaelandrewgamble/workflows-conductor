# Workflows Conductor — Architecture & Build Plan

A Claude Code plugin that surfaces dynamic-workflow run management inside the VS Code / Cursor extension, where the native `/workflows` TUI is unavailable (open issue [anthropics/claude-code#72292](https://github.com/anthropics/claude-code/issues/72292), duplicates #71738, #67495, #54602).

**Status**: v1 design, 2026-07-02. Researched via 4 parallel research agents (disk audit on real artifacts, CLI docs, plugin system docs, extension bundle inspection), then adversarially reviewed by a 6-agent verification/critique workflow. All platform claims below are either doc-cited, empirically verified on this machine, or explicitly marked unverified with a scheduled M0 spike.

---

## 0. Why this plugin — and why not just the terminal

**The UX reference is Claude Code Desktop's tasks pane.** Doc-confirmed ([desktop docs](https://code.claude.com/docs/en/desktop), "Watch background tasks"): *"The tasks pane shows the background work running inside the current session: subagents, background shell commands, and dynamic workflows. Open it from the Views menu or drag it into your layout. Click any entry to see its output in the subagent pane or stop it."* The VS Code extension has no equivalent — this plugin brings that experience to VS Code/Cursor users. Two corrections to keep the reference honest:

- We match the pane's **read surface** (inspect live and completed runs, per-agent output). We cannot match **stop** — Desktop stops runs because it owns the session process, the same reason the CLI TUI can; there is no external run-control API (§2.6).
- We **exceed** the pane on breadth: it shows only the current session, while this plugin reads `~/.claude/projects/` directly, so it sees runs started from the CLI, Desktop, *and* the extension, across all sessions and projects. This cross-surface visibility is a differentiator to advertise, **not a scope driver** — it falls out of the file-based design for free (§2.2 already globs all project dirs), and it must not expand the initial build. One real implication it reinforces: multiple surfaces means multiple CLI versions writing artifacts concurrently, which is another argument for the schema-drift detection in §2.5.

The honest steelman for the trivial alternative: opening the IDE's integrated terminal, running `claude`, and typing `/workflows` gives the real TUI, including pause/resume/stop/restart — capabilities this plugin can **never** replicate (no external run-control API exists; confirmed against [workflows docs](https://code.claude.com/docs/en/workflows#manage-runs)).

The plugin's defensible value is precisely what the terminal path cannot do:

1. **Cross-project, cross-surface run aggregation** — one view over every project's runs (`~/.claude/projects/*/*/workflows/`) regardless of which surface launched them; no single CLI session or Desktop tasks pane shows this.
2. **Live visibility into extension-owned runs** — a workflow launched in the extension chat belongs to the extension's bundled CLI process; a separate terminal session cannot attach to it, and the owning chat session is busy executing it.
3. **In-chat retrospective inspection** without leaving the conversation.
4. **Save / re-run from chat** — recover a killed run's script and relaunch it.

For run *control* (pause/stop/restart of a terminal-launched run), the README will recommend the terminal `/workflows` path explicitly. We do not fake what we cannot do.

---

## 1. Ground truth

### 1.1 On-disk schema (empirically audited; UNDOCUMENTED — treat as unstable, see §2.6)

```
~/.claude/projects/<encoded-cwd>/            # cwd, non-alphanumerics → "-"
├── <sessionUUID>.jsonl                      # main transcript (large; not needed)
└── <sessionUUID>/
    ├── workflows/
    │   ├── wf_<runId>.json                  # AUTHORITATIVE run record
    │   └── scripts/<name>-wf_<runId>.js     # script copy (may be MISSING)
    └── subagents/workflows/wf_<runId>/
        ├── journal.jsonl                    # {"type":"started"|"result","key":"v2:<sha256>","agentId",...}
        ├── agent-<agentId>.jsonl            # full per-agent transcript
        └── agent-<agentId>.meta.json        # {"agentType":"workflow-subagent"}
```

`wf_<runId>.json` fields: `runId, taskId, workflowName, status, error?, result, summary, script` (**full source inlined**)`, scriptPath, phases, workflowProgress, agentCount, defaultModel, startTime, timestamp, durationMs, totalTokens, totalToolCalls, logs`.

Facts a reader must honor (each maps to a reader requirement in §2.5):

- **Only terminal statuses persist.** Observed vocabulary: `completed`, `killed` — from a biased sample (14/1, zero failure-path runs), so the schema's `error?` field implies other terminal statuses exist. Status must be an **open enum**.
- **The run record is written only at terminal state.** For an in-flight run, disk holds *only* the journal (hashed cache keys + agentIds), agent transcripts, and possibly a script copy — **no workflow name, no phases, no agentCount**. Live views must be scoped to what exists.
- **No lock/PID files; liveness is inferred.** Naive "journal `started` without `result` → live" misreports both ways: crashed runs read as live forever; between-phases runs (all agents returned, orchestrator still executing) read as dead. Requires an **mtime-recency signal**.
- **Cross-project split**: a run's state JSON and script can live in *different* `<encoded-cwd>` dirs sharing a session UUID (cwd changed mid-session; observed here between `capicola` and `portfolio-dev`). The inlined `.script` is authoritative; script files can be absent.
- `result` (and journal `result`) are string-or-object, workflow-defined.
- **Torn reads are the common case, not an edge case**: `journal.jsonl` is appended exactly when a live view reads it; `wf_*.json` write atomicity is unknown.
- Sessions auto-delete after `cleanupPeriodDays` (default 30) — dirs vanish out from under watchers and between a list and an inspect.
- Journal keys are already versioned (`v2:` prefix) — Anthropic has changed this format before and will again. Two CLI versions write artifacts concurrently on a typical machine (terminal CLI vs extension-bundled CLI).
- Scale is trivial: ~440 files / ~430 MB across 10 project dirs here; runs have 1–8 agents, run JSON 32–69 KB.

### 1.2 CLI `/workflows` capabilities and their file-level mechanics (docs, v2.1.154+)

| Key | Action | Mechanics |
|---|---|---|
| ↑/↓/Enter/Esc/j/k | navigate runs → phases → agent detail | reads run state |
| `f` (v2.1.186+) | filter agents by status | display-level |
| `s` | save run as reusable workflow | writes script to `.claude/workflows/<name>.js` (project) or `~/.claude/workflows/<name>.js` (user); invoked thereafter as `/<name>`; monorepo: nearest dir wins (v2.1.178+) |
| `p` | pause / resume | in-process; resume = journal replay of cached agent results + live execution of the rest. **Same-session only** (confirmed: [docs](https://code.claude.com/docs/en/workflows#resume-after-a-pause)) |
| `x` / `r` | stop agent or run / restart agent | live-process control, no external API (confirmed) |

### 1.3 Platform constraints (verified)

- **Plugins have zero UI contribution API in the extension.** Confirmed by docs (component list is exhaustive: `skills/`, `commands/`, `agents/`, `hooks/`, `.mcp.json`, `.lsp.json`, `monitors/`, `bin/`, `settings.json`) and by inspection of the installed extension bundle (all webview providers are extension-owned). Output surfaces, ranked: localhost web app (user-opened) > files opened in editor > deep links > chat markdown.
- **Skills inherit normal session permissions** (confirmed) — a skill can Read `~/.claude/projects/` without an MCP server. Caveats: reads outside the workspace may prompt per-call, and sandboxed-Bash profiles can deny `~/.claude` access (M0 verifies in-extension behavior).
- **Plugin MCP servers, hooks, and monitors run unsandboxed at user privilege** (confirmed). `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` (persistent dir at `~/.claude/plugins/data/<id>/`, auto-created) are documented. MCP servers auto-start on plugin enable.
- **Hook events confirmed real** (plugins-reference): `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `PostToolBatch`, plus worktree/teammate events. Handler types: `command`, `http`, `mcp_tool`, `prompt`, `agent`. This makes **event-driven live tracking** viable (§2.4).
- **SDK** (`@anthropic-ai/claude-agent-sdk`): full *session* surface (`listSessions`, `getSessionMessages`, `query({resume, forkSession})`, slash-command dispatch via prompt string) but **no workflow-run primitives** — workflow state is opaque to the SDK.
- **Deep links**: `vscode://anthropic.claude-code/open?prompt=…&session=…` is documented — but **Cursor registers only the `cursor://` URL scheme** (verified in Cursor's Info.plist), so scheme must be selected per host. Whether *any* link scheme renders clickable in the extension chat webview is **unverified** (DOMPurify sanitization observed) → M0 spike.
- **Cursor**: officially supported install target; historically fragile across Cursor updates (#11236). The extension runs its own **bundled** CLI — validating anything in a terminal validates nothing about the extension path. Every milestone's exit criterion is "verified inside the Cursor extension chat," with Cursor + extension versions pinned in the repo.
- The extension↔CLI bridge (localhost WebSocket/MCP, per-activation token under `~/.claude/ide/`) is private. **We do not build on it.**

### 1.4 Remaining unknowns → resolved by the M0 spike, gating M4/M5 design

1. Do `http://`, `vscode://`, `cursor://`, `command:` links render clickable in the extension chat (VS Code and Cursor)?
2. Can a skill get the Workflow tool invoked with an externally supplied script (vs only saved-name `/<name>` invocation)?
3. Do skill Read/Bash calls under `~/.claude/projects` prompt per-call inside the extension? Under sandbox mode?
4. Do `SubagentStart`/`SubagentStop` hooks fire for workflow subagents specifically, and what payload do they carry?

---

## 2. Architecture

**Name** `workflows-conductor` · **Namespace** `/conductor:*`

### 2.1 Components

```
workflows-conductor/
├── .claude-plugin/plugin.json      # manifest; records tested CLI version range
├── skills/
│   ├── status/SKILL.md             # /conductor:status [--all] [--limit N]
│   ├── inspect/SKILL.md            # /conductor:inspect <runId>
│   ├── save/SKILL.md               # /conductor:save <runId> <name> [--user] [--force]
│   ├── rerun/SKILL.md              # /conductor:rerun <runId>
│   └── dashboard/SKILL.md          # /conductor:dashboard [stop]
├── hooks/hooks.json                # optional live-tracking sidecar (M4b)
├── .mcp.json                       # conductor MCP server (stdio)
├── server/
│   ├── index.js                    # MCP entry (thin transport)
│   ├── reader.js                   # pure, transport-agnostic core — THE product
│   ├── cli.js                      # ≤20-line shim for M1 (discarded at M2)
│   └── dashboard/                  # detached HTTP+SSE server
└── marketplace.json
```

### 2.2 Data flow

```
disk (~/.claude/projects/**)  ──read──►  reader.js (single parse boundary)
    ├─► MCP tools ─► skills ─► chat markdown          (tier 1: retrospective, always works)
    ├─► dashboard (HTTP+SSE) ─► browser, auto-opened  (tier 2: live + rich)
    └─► saveAsWorkflow ──write──► .claude/workflows/*.js   (the one write path)
optional: hooks (SubagentStart/Stop) ──append──► ${CLAUDE_PLUGIN_DATA}/live-runs.jsonl ──► reader liveness
```

File-based, no dependency on the private IDE bridge, works whether or not any CLI process is running.

**Chat-surface economics** (a design constraint, not an afterthought): everything a skill renders lands in the context window of the session the user is trying to protect. Tool contracts therefore enforce projection:

- `conductor_list_runs({scope, limit=10})` → fixed compact rows (runId, name?, status, agents done/total, tokens, duration, age/expires-in). Never inlines scripts or results.
- `conductor_get_run(runId)` → metadata + summary only. **Script excluded**; full `result` elided past a size cap with a "see dashboard" pointer.
- `conductor_get_agents(runId)` → journal-derived rows + **transcript file paths** (for targeted Read), never inlined transcripts.
- `conductor_get_script(runId)` → the only call that returns script source.
- `conductor_save_workflow(runId, name, scope, force)` → writes and confirms path.
- `conductor_start_dashboard()` / `conductor_stop_dashboard()` → §2.4 lifecycle.

### 2.3 Gap matrix — honest capability accounting

| `/workflows` capability | Conductor | Mechanism | Limitation |
|---|---|---|---|
| List/inspect terminal-state runs, agents, results, tokens | ✅ full | file reads | none |
| Cross-project / cross-surface aggregation | ✅ (new — no existing surface has it) | glob all project dirs; runs land on disk regardless of launching surface | none |
| Save run as workflow (`s`) | ✅ full | extract inlined script → file | collision policy is ours |
| Filter agents by status (`f`) | ✅ dashboard / ⚠️ chat | rendering / re-prompt per change | chat filter costs a model turn |
| Live progress | ⚠️ scoped | dashboard: agents started/finished, transcript tails, last-activity; name/phases only if script copy or hook sidecar present | no run record on disk until terminal state |
| Pause (`p`) | ❌ | — | in-process only; use terminal `/workflows` |
| Resume | ❌ | — | same-session journal replay only; not externally reachable. Recovery path: `/conductor:rerun` (fresh run) |
| Stop (`x`) / restart (`r`) | ❌ | — | requires Anthropic run-control API |
| Re-run from script | ✅ (new) | save-to-name + `/<name>` invocation (plan A); inline Workflow-tool injection only if M0 spike proves it | fresh run, no cached results; occupies the current session |

### 2.4 Live tracking & dashboard design

**Design target**: the Desktop tasks pane (§0) — a run list with per-entry drill-down into agent output — extended with what the pane lacks: cross-session/cross-surface scope and terminal-state history. Stop buttons are deliberately absent (§2.3).

**Watching**: one `fs.watch(~/.claude/projects, {recursive: true})` (FSEvents on macOS) with path-suffix filtering (`workflows/`, `subagents/workflows/`) and debounce for main-transcript noise, plus a periodic re-glob fallback (coalesced events; Linux portability). Never watch per-session dirs directly — they are created lazily and deleted by cleanup.

**Liveness** (tri-state, from reader): `live?` (max mtime across journal/agent transcripts/session transcript < N min), `stale` (no run record, no recent activity — probably crashed/interrupted), terminal (raw status passthrough). Always display last-activity time, never a bare status word. Unmatched `started` counts shown as-is.

**Hook sidecar (optional upgrade, M4b)**: a `command` hook on `SubagentStart`/`SubagentStop` appends events to `${CLAUDE_PLUGIN_DATA}/live-runs.jsonl`, giving event-driven (not heuristic) liveness for sessions where the plugin is enabled. Strictly additive — reader works without it.

**Dashboard process lifecycle** (specified now, not discovered at M4):
- Spawned **detached**, `stdio: 'ignore'`, own process group — never inherits the MCP stdio protocol channel.
- Fixed port with health-check probe: `start_dashboard` is *ensure-running* — if a conductor dashboard already answers, return its URL (idempotent across sessions/windows). Pidfile in `${CLAUDE_PLUGIN_DATA}`.
- **Auth**: random bearer token embedded in the returned URL; Host/Origin validation on every request incl. SSE (transcripts contain secrets; unauthenticated localhost is readable by any local process and DNS-rebinding pages).
- Idle self-shutdown (no clients for 30 min) so reload/uninstall can't orphan it; explicit `conductor_stop_dashboard`.
- The MCP server is unsandboxed → `start_dashboard` **auto-opens the browser** (`open <url>` on macOS). No dependency on chat-link clickability.
- ENOENT anywhere (cleanup raced a view) → first-class `expired` state: list rows show "expired", open detail views get an SSE `run-expired` event, never a crash.

### 2.5 Reader requirements (M1 exit criteria, not polish)

1. **Open status enum**: raw status passthrough + derived flags (`isTerminal`, liveness tri-state); unknown statuses rendered verbatim with a marker. Synthetic unknown-status fixture.
2. **Tolerant parsing**: JSONL reader drops trailing partial lines; run-JSON parse failure retries once then degrades that record to `unreadable`; no single file ever blanks a listing. Truncated-file fixtures.
3. **Project membership rule**: always glob all project dirs; a run belongs to the current project if its run JSON *or* its script lives under the **forward-encoding of cwd** (never reverse-decode dir names — ambiguous: `-a-b` = `a/b` or `a-b`). Orphan scripts sort by file mtime.
4. **Schema-drift detection at the parse boundary**: minimal required-field validation tags every record `ok | degraded | unknown-format`, propagated to skill output and a dashboard banner ("artifacts written by an untested CLI version"). Fixture corpus labeled by CLI version; canary test re-runs the reader on freshly generated artifacts after CLI updates; tested version range recorded in plugin.json/README.
5. **Expiry as data**: run age and "expires in Nd" computed from `cleanupPeriodDays`; `/conductor:save` warns near the horizon.
6. **Empty state**: zero runs / missing dirs → helpful message ("no workflow runs found — requires CLI ≥ 2.1.154; launch one with `ultracode: …`"), never an error. Zero-runs and mid-scan-deletion fixtures.

### 2.6 What requires Anthropic (filed as upstream asks, not built around)

1. `/workflows` panel / Desktop-tasks-pane parity in the extension (#72292 — the reason this plugin exists; Desktop already ships the pane, so the precedent exists in-house).
2. Incremental persistence of run state (`running`/`paused`, per-phase completion) to `wf_*.json` — would delete our heuristics.
3. Workflow run-control API (pause/resume/stop by runId) in SDK or CLI flags.
4. Plugin UI contribution point (webview/panel) — would move the dashboard into the IDE.
5. Documented/stabilized `wf_*.json` + journal schema.

### 2.6b Considered and deliberately deferred (2026-07-04)

Dashboard action buttons (save/re-run/stop) were designed but not built. Run
control is ownership-bound: a dashboard Stop could only govern headless
`claude -p` children the dashboard itself spawned — a run category that
exists only to be managed. The user's runs are chat-launched, and the owning
chat already provides stop/resume conversationally (TaskStop / Workflow
resumeFromRunId) plus `/conductor:rerun`. Revisit only if dashboard-initiated
execution becomes a real need, or if Anthropic ships an external run-control
API (§2.6 ask #3). A speculative plugin-monitor control channel (dashboard →
control file → monitor wakes owning session's model) is unverified and
likewise parked.

### 2.7 Plugin Dev Toolkit verdict

Use `/plugin-dev:create-plugin` for scaffold, manifest validation, and skill review only. The reader, MCP server, and dashboard are hand-built — the toolkit's guided flow targets skill/hook-centric plugins, not engine-heavy ones. Hybrid: toolkit for structure and validation gates, manual for the engine.

---

## 3. Phased build plan

Every milestone's exit criterion includes **verified inside the Cursor extension chat** (not a terminal), with Cursor + extension versions pinned in the repo. Estimate: **10–15 working days**.

**M0 — Scaffold + verification spikes (1 day).** Plugin manifest, marketplace.json, local install; empty skill visible in Cursor slash menu. Then the four §1.4 spikes, each ~30–60 min: link-scheme clickability matrix (VS Code + Cursor), Workflow-tool inline-script invocation, in-extension `~/.claude` read permission behavior (incl. sandbox mode), hook-event firing + payload for workflow subagents. **M4/M5 designs are gated on these results.**

**M1 — `/conductor:status`, zero processes (2–3 days).** `reader.js` as a pure library + ≤20-line CLI shim invoked via Bash (suggested allow rule shipped: `Bash(node ${CLAUDE_PLUGIN_ROOT}/server/cli.js*)`). All §2.5 requirements are exit criteria — the quirks *are* the hard part. Fixtures: real anonymized artifacts from this machine + synthetic unknown-status, truncated, zero-runs, mid-deletion cases. *Milestone: retrospective run list (terminal-state runs + heuristic live flags) across projects, rendered in Cursor chat — usable from a second session while a run executes.* Note the honest limitation: skills cannot serve the mid-run moment in the owning session; that is the dashboard's job.

**M2 — MCP server (1–2 days).** Wrap reader in a stdio MCP server via `.mcp.json`; skills switch to typed tools with the §2.2 projection contracts; add `/conductor:inspect`. Verify how the extension-bundled CLI spawns plugin MCP servers; decide the runtime story (document Node ≥ 18 prerequisite with a clear failure diagnostic, or bundle a single-file build under `bin/`). *Milestone: one-time tool approvals replace per-call Bash prompts; typed tools visible in `/mcp`.*

**M3 — Save (½–1 day).** `conductor_save_workflow` + `/conductor:save` with CLI-matching semantics (project vs `--user` scope, monorepo nearest-dir, no-overwrite without `--force`, near-expiry warning). *Milestone: a killed run's script saved and invoked as `/<name>` in a fresh session.*

**M4 — Live dashboard (2–3 days).** Per §2.4 spec (recursive root watch, tri-state liveness, detached lifecycle, token auth, auto-open, expired-run semantics). Scope the live view to what disk supports: agents started/finished, transcript tails, last-activity; name/phases recovered from script-copy `meta` when present, shown as "unknown" otherwise. *Milestone: watch a live ultracode run's agents progress in the browser while the extension chat that owns it is busy.*

**M4b — Hook sidecar (½ day, optional).** `SubagentStart`/`SubagentStop` → `${CLAUDE_PLUGIN_DATA}/live-runs.jsonl`; reader prefers events over heuristics when present. Ships only if the M0 spike confirmed payloads identify workflow subagents.

**M5 — Re-run (1 day).** Plan A: `/conductor:rerun` = save script under a temp/named workflow (reuses M3) + hand the user the `/<name>` invocation; direct Workflow-tool injection only if M0 proved it. Deep links (host-detected `cursor://` vs `vscode://`) included only if M0 proved clickability; otherwise copy-paste fallback text. Document: rerun is a fresh run and occupies the current session. *Milestone: killed run relaunched end-to-end in Cursor.*

**M6 — Hardening + publish (1–2 days).** Sandbox-mode test pass; README: value proposition vs the terminal (§0), run-control recommendation, Node prerequisite, tested version range, Cursor-update fragility note; file the §2.6 upstream issues; publish marketplace repo. *Milestone: `/plugin marketplace add michaelgamble/workflows-conductor` works on a clean machine.*

### Risk register (top 3)

| Risk | Mitigation |
|---|---|
| Anthropic changes the undocumented `wf_*.json`/journal schema in any release | drift detection at the parse boundary (§2.5.4); degrade per-record, never crash; canary fixtures per CLI version |
| M0 spikes fail (no clickable links, no inline Workflow invocation) | designs for M4/M5 have pre-written fallbacks (auto-open browser; save-then-invoke); nothing downstream assumes spike success |
| Cursor update breaks the extension mid-build | pinned versions per milestone; CLI-path smoke tests isolate plugin regressions from host regressions |
