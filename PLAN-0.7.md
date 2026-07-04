# 0.7.0 — Live Agent Observability (+ 0.6.x fixes)

Goal: make the dashboard answer "what is running right now, what is each agent doing, and how long has it been at it" — the Desktop tasks-pane experience, agent-level, cross-surface. Incorporates the 2026-07-03/04 discussion.

## Scope

### Bugs (fold into this release)
- **B1 — stale hook status**: `background_tasks` claims from hook events are point-in-time snapshots. Drop a "running" claim when (a) a terminal `wf_*.json` exists for that runId, or (b) `seenAt` is older than 10 min with no fresher event. LIVE strip shows an explicit "nothing currently in flight" when empty.
- **B2 — detail panel overlap**: table section gets `overflow:auto; min-width:0`; detail becomes a fixed-position dismissible drawer with explicit background (also fixes narrow windows).

### Features
- **F1 — sortable + filterable table** (vanilla, no deps): click-to-sort on every column (asc/desc), text filter over name/status/project. ~25 lines. Optional (default on): group-by-project collapsible sections.
- **F2 — Active Runs section** (the headline): per-run card at the top when a run is live, containing per-agent cards:
  - state: running (started, no journal result) / done
  - elapsed: now − start (hook event timestamp, else transcript first-line timestamp)
  - freshness: pulse animation when transcript mtime < 10 s; "quiet 2m — stalled?" state when running but silent
  - current action: parsed tail of the agent transcript (last tool call name + one-line input summary, or last text snippet)
  - live token burn summed from transcript usage fields
  - phase plan skeleton parsed from the run's on-disk script `meta.phases` ("Phase 2 of 3 — Verify"), agents-seen per phase
- **F3 — click-through live tail**: agent card click opens a tail pane streaming the last N transcript events (formatted text feed), refreshed by the existing fs watcher. **Security invariant: the tail endpoint resolves and validates every path to be inside `~/.claude/projects` — no arbitrary reads, even token-bearing.**
- **F4 — just-finished grace**: runs that reached terminal state < 5 min ago stay in the Active section labeled "finished Nm ago", then collapse. (Covers the "did my workflow actually start/finish?" moment.)

### Honest limitation (documented in UI, not faked)
Queued/pending agents are runtime-memory only — nothing reaches disk until an agent starts. The phase skeleton is the best available proxy. Persisting queue state is upstream ask #6 (ARCHITECTURE.md §2.6).

## Execution plan (parallel where files don't collide)

**Phase 1 — parallel build** (file-ownership split, no overlap):
- Agent A owns `server/reader.js` + `server/reader.test.js`: `getLiveAgents(runId)` merging journal pairing, hook-event start/stop times, transcript tail parse (last tool/text, first-line timestamp, usage sum, mtime), plus `parsePhases(script)`. Synthetic live fixtures: growing transcript, torn tail line, hook-event log.
- Agent B owns `server/dashboard.js` UI layer only: B2 layout fix, drawer, F1 sort/filter/grouping — against the existing `/api/runs` shape (no new endpoints needed for this slice).

**Phase 2 — integration (main session)**: new endpoints `/api/live` and `/api/agent-tail` (with the F3 path invariant), B1 stale-hook fix, Active Runs section + agent cards + tail pane wiring, F4 grace window.

**Phase 3 — parallel verify**:
- Security agent: attack `/api/agent-tail` (path traversal, symlinks, token replay, Origin) and the drawer's HTML injection surface (transcript content is untrusted — must be escaped).
- Live E2E: launch a real multi-agent test workflow and watch it through the dashboard end-to-end (agents appear → pulse → actions update → tail streams → grace window → collapse).
- Code review pass over the diff.

**Phase 4 — ship**: 0.7.0 bump, validate, plugin update, commit; user verifies in Cursor (dashboard reload only — no session restart needed, the dashboard is standalone).

**Phase 5 — M6 publish (unchanged, needs user decisions)**: GitHub repo creation + push, README polish, file upstream issues (§2.6 incl. queue-state persistence).

## Defaults chosen (flag if you want different)
- Just-finished grace window: 5 minutes.
- Group-by-project: on, collapsible.
- Tail pane: text feed (not chat-style rendering) in v1.
