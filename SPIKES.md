# M0 Verification Spikes — Results

Environment: Cursor + Claude Code extension (bundled CLI ~2.1.199), macOS, 2026-07-03. Each spike maps to an unknown in ARCHITECTURE.md §1.4.

## Spike 2 — Workflow tool accepts an externally supplied script ✅ CONFIRMED

`Workflow({scriptPath: <file written by another process>})` executed a script authored outside the tool call and returned its result (`{pong: "PONG"}`; run `wf_3715e2a6-e99`). Implication for `/conductor:rerun`: **direct scriptPath invocation is viable** — extract the inlined script from `wf_<id>.json`, write to a temp file, invoke `Workflow({scriptPath})`. The save-then-`/<name>` fallback is not needed for rerun (still used for `/conductor:save`, which is its own feature). ARCHITECTURE.md §2.3/M5 "plan A vs plan B" resolves in favor of the simpler path.

Caveat: verified in *this* session where the Workflow tool is available. A skill must still get the main-loop model to make this tool call — trivially true when the skill's instructions say to do it (this session is the proof), but the Workflow tool's opt-in gating means the skill instructions constitute the required explicit trigger.

## Spike 3 — File access to `~/.claude/projects/` from the extension session ✅ CONFIRMED (this config)

Both access paths worked with no permission prompts, against a *foreign* project's session dir (job-agent, not the cwd project):

- `Read` tool on `.../job-agent/<session>/workflows/wf_123f555b-470.json` — succeeded.
- `Bash` (`ls`, `jq`) on the same tree — succeeded.

Not yet tested: sandbox-enabled Bash profiles and default-permission setups (this machine's settings may be permissive). M1 ships a suggested allow rule and tests once with sandbox mode on, per plan.

### Bonus discovery — the run-record schema is richer than the M-audit reported

The June-2026 run record read during this spike (`wf_123f555b-470.json`, written by CLI ~2.1.15x-era, `claude-opus-4-7` default model) contains a `workflowProgress` array with **full per-agent entries**, not just phase declarations:

```
{"type":"workflow_agent", "index", "label", "phaseIndex", "phaseTitle", "agentId",
 "isolation", "model", "state": "done", "startedAt", "queuedAt", "attempt",
 "lastToolName", "lastToolSummary", "promptPreview", "lastProgressAt",
 "tokens", "toolCalls", "durationMs", "resultPreview"}
```

The original disk audit (different runs, same machine) reported `workflowProgress` as phase-only with "no completion flags." Both observations are real → **the schema varies across runs/CLI versions on one machine**, which upgrades two architecture positions:

1. The reader should *prefer* `workflowProgress` `workflow_agent` entries when present (per-agent state, tokens, timing, previews — everything the status view wants) and fall back to journal pairing when absent.
2. This is live proof of ARCHITECTURE.md §2.5.4's schema-drift premise — tolerant, per-record, capability-detecting parsing is mandatory, not defensive overengineering.

## Spike 1 — Link clickability in extension chat ✅ CONFIRMED (rendering)

All five test forms rendered as clickable in Cursor's Claude chat panel (2026-07-03, user-verified): plain `http://` URL, markdown `http://` link, `vscode://` deep link, `cursor://` link, and `command:` link. The DOMPurify-sanitization concern did not materialize at the rendering layer.

Scope caveat: this verifies *rendering*, not end-to-end behavior on click — in particular `vscode://` links won't open Cursor (only the `cursor://` scheme is registered there) and `command:` execution wasn't observed. For the plan this is enough: M4's dashboard URL is clickable (and auto-open makes it belt-and-braces), and M5 deep links just need per-host scheme selection as already specified.

## Spike 4 — SubagentStart/SubagentStop hook payloads ✅ CONFIRMED (better than hoped)

First captured events (2026-07-03, a workflow subagent from a real run) settle every open question:

- **Workflow subagents are identifiable**: `agent_type: "workflow-subagent"` in both Start and Stop payloads.
- **Run ID is extractable**: SubagentStop carries `agent_transcript_path` pointing into `.../subagents/workflows/<runId>/agent-<id>.jsonl`.
- **Live run status rides along**: SubagentStop includes a `background_tasks` array with `{id, type: "workflow", status: "running", name, description}` — actual live state that the disk never persists. This upgrades the M4b hook sidecar from liveness hints to real status tracking.
- Also present: `last_assistant_message`, `effort`, `permission_mode`, `session_id`, `cwd`.
- **Hooks hot-loaded** into an already-running session after plugin install — no restart was needed for hook activation.
- `${CLAUDE_PLUGIN_DATA}` resolved to `~/.claude/plugins/data/conductor-workflows-conductor/` (id = plugin-marketplace compound), created on demand as documented.

## M2/M3 field notes (2026-07-03, verified in Cursor)

- **Saved workflows register as commands by `meta.name`, NOT filename** — contradicts the docs-derived assumption. Observed: a file saved as `arch-critique.js` with `meta.name: 'conductor-arch-critique'` registered as `/conductor-arch-critique`; after rewriting meta.name, it re-registered as `/arch-critique` immediately (no restart — `.claude/workflows` hot-reloads). `saveAsWorkflow` now rewrites meta.name to the requested command name.
- **Plugin MCP tool namespace**: tools surface as `mcp__plugin_<pluginName>_<serverName>__<tool>` (e.g. `mcp__plugin_conductor_conductor__list_runs`), not `mcp__<serverName>__<tool>`. Skill `allowed-tools` updated to the real names.
- Plugin updates are version-gated: `claude plugin update` is a no-op unless plugin.json `version` is bumped — bump every iteration.

## M0 field notes (from the first real install + run)

- `/plugin` slash commands are NOT available in the extension chat ("/plugin isn't available in this environment"); `claude plugin …` CLI commands work and installs are user-scoped, shared across surfaces. README updated.
- v0 skill bugs found and fixed: `find -path '*/workflows/wf_*.json'` also matched per-agent meta files under `subagents/workflows/wf_*/` because `*` in `-path` crosses slashes (fixed with `-name 'wf_*.json' -not -path '*/subagents/*'`); a zsh glob loop errored on no matches (fixed: enumerate with `find -type d`).
- The liveness heuristic worked on its first outing: it flagged `wf_5ea2970d-fcf` (portfolio-dev, no run record, files modified seconds earlier) as live — a genuinely in-flight run at that moment.
