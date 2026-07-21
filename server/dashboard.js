#!/usr/bin/env node
// conductor dashboard — standalone localhost HTTP+SSE server, zero deps.
// Spawned detached by the MCP server's start_dashboard tool; may outlive it.
// Security: binds 127.0.0.1 only, bearer token on every route (transcripts
// can contain secrets), Origin/Host validated, idle self-shutdown.

import http from 'node:http'
import { promises as fs, watch } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { listRuns, getRun, getAgents, getLiveAgents, getScript, parseMetaDescription, parseTranscriptTail, readTranscriptPrompt, deriveTitle, DEFAULT_PROJECTS_DIR } from './reader.js'

const PORT = Number(process.env.CONDUCTOR_PORT || 7423)
const TOKEN = process.env.CONDUCTOR_TOKEN
const DATA_DIR = process.env.CONDUCTOR_DATA_DIR || path.join(os.homedir(), '.claude', 'plugins', 'data', 'conductor-workflows-conductor')
const IDLE_LIMIT_MS = 30 * 60 * 1000
const HOOK_CLAIM_TTL_MS = 10 * 60 * 1000
const JUST_FINISHED_MS = 5 * 60 * 1000
const VERSION = '1.2.0'

if (!TOKEN) { console.error('CONDUCTOR_TOKEN required'); process.exit(2) }

let lastActivity = Date.now()
const sseClients = new Set()

// ── live status from hook events (spike 4): latest background_tasks entries ──
// Hook claims are point-in-time snapshots (B1): a "running" claim is dead once
// a terminal run record exists for its runId, or once it ages past the TTL
// with no fresher event.
async function liveFromHookEvents({ recordedIds = new Set(), now = Date.now() } = {}) {
  const out = new Map()
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, 'events.jsonl'), 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let ev; try { ev = JSON.parse(line) } catch { continue }
      const runId = ev.agent_transcript_path?.match(/\/workflows\/(wf_[^/]+)\//)?.[1] ?? null
      for (const t of ev.background_tasks ?? []) {
        // Keep the first non-null runId per task: later events from
        // NON-workflow agents carry the same background_tasks but a null
        // runId — overwriting would orphan the claim.
        if (t.type === 'workflow') {
          const prev = out.get(t.id)
          out.set(t.id, { taskId: t.id, name: t.name, status: t.status, runId: runId ?? prev?.runId ?? null, seenAt: ev.conductor_logged_at ?? prev?.seenAt ?? null })
        }
      }
    }
  } catch { /* no events yet */ }
  return [...out.values()].filter(c => {
    if (c.status !== 'running') return false
    if (c.runId && recordedIds.has(c.runId)) return false
    const age = c.seenAt ? now - Date.parse(c.seenAt) : Infinity
    return age < HOOK_CLAIM_TTL_MS
  })
}

// ── liveState TTL cache: the endpoint is polled hard during active runs and
// each computation walks the projects tree several times ──
let liveCache = null, liveCacheAt = 0
const LIVE_CACHE_TTL_MS = 1500

// ── /api/live: everything in flight + just-finished grace window (F2/F4) ──
async function liveState() {
  const now = Date.now()
  if (liveCache && now - liveCacheAt < LIVE_CACHE_TTL_MS) return liveCache
  const all = await listRuns({ scope: 'all', limit: 10_000, now })
  const recordedIds = new Set(all.runs.map(r => r.runId))
  const hookLive = await liveFromHookEvents({ recordedIds, now })

  const activeIds = new Map()   // runId -> source tag
  for (const c of all.liveCandidates) activeIds.set(c.runId, c.derivedStatus)
  for (const h of hookLive) if (h.runId && !activeIds.has(h.runId)) activeIds.set(h.runId, 'running (hook)')

  const active = []
  for (const [runId, source] of activeIds) {
    const detail = await getLiveAgents(runId, { dataDir: DATA_DIR, now })
    const cand = all.liveCandidates.find(c => c.runId === runId)
    const hook = hookLive.find(h => h.runId === runId)
    const rec = all.runs.find(r => r.runId === runId)   // resumed runs have a (stale) record — with the name
    active.push({
      runId, source,
      name: hook?.name ?? rec?.workflowName ?? detail.workflowName ?? null,
      description: detail.description ?? null,
      projectDir: cand?.projectDir ?? null,
      lastActivity: cand?.lastActivity ?? null,
      resumedAfter: cand?.resumedAfter ?? null,
      phases: detail.phases ?? [],
      agents: detail.agents ?? [],
    })
  }

  const justFinished = all.runs
    .filter(r => r.timestamp && now - Date.parse(r.timestamp) < JUST_FINISHED_MS)
    .map(r => ({ runId: r.runId, workflowName: r.workflowName, status: r.status, agentCount: r.agentCount, totalTokens: r.totalTokens, durationMs: r.durationMs, finishedAgoMs: now - Date.parse(r.timestamp) }))

  // Hook claims that never got a runId still deserve a chip — a run can be
  // mid-flight before any workflow subagent has stopped.
  const unattributed = hookLive.filter(h => !h.runId).map(h => ({ taskId: h.taskId, name: h.name, seenAt: h.seenAt }))

  liveCache = { active, justFinished, unattributed, generatedAt: now }
  liveCacheAt = now
  return liveCache
}

// ── AI summaries: one-sentence Haiku summaries of agent goals via the user's
// `claude` CLI (subscription auth — no API key handled here). Goals are
// immutable, so the cache (DATA_DIR/summaries.json) never expires. ──
const SUMMARIES_FILE = path.join(DATA_DIR, 'summaries.json')
const HOME = os.homedir()
const tidy = s => typeof s === 'string' ? s.split(HOME).join('~') : s
let summaries = {}
async function loadSummaries() {
  try { const v = JSON.parse(await fs.readFile(SUMMARIES_FILE, 'utf8')); if (v && typeof v === 'object' && !Array.isArray(v)) summaries = v } catch { /* first run */ }
}
async function persistSummaries() {
  try { await fs.writeFile(SUMMARIES_FILE, JSON.stringify(summaries), { mode: 0o600 }) } catch { /* non-fatal */ }
}
const summaryQueue = []
const summaryInFlight = new Set()   // queued or running — dedupes repeat polls
const summaryFailed = new Set()     // errored keys: reported as error, not retried this process
let summaryPumping = false

function summarizeViaCli(prompt) {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v) } }
    let child
    try {
      // --setting-sources '': without it the CLI loads the user's settings,
      // plugins and MCP servers — measured to hang past 30s. --disallowed-tools:
      // the goal text embeds an agent task; the summarizer must never act on it.
      child = spawn('claude', ['-p', prompt, '--model', 'haiku', '--setting-sources', '', '--disallowed-tools', '*'], { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'ignore'] })
    } catch (err) { return reject(err) }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } settle(reject, new Error('timeout')) }, 30_000)
    let out = ''
    child.stdout.on('data', d => { if (out.length < 4096) out += d })
    child.on('error', err => settle(reject, err))   // e.g. ENOENT — claude binary missing
    // First non-empty line only: despite "No preamble" the model sometimes
    // appends a second "let me…" sentence.
    child.on('close', code => {
      const line = out.split('\n').map(s => s.trim()).find(Boolean) ?? ''
      return (code === 0 && line) ? settle(resolve, line.slice(0, 600)) : settle(reject, new Error('exit ' + code))
    })
  })
}

function enqueueSummary(runId, agentId) {
  const key = runId + '/' + agentId
  if (summaries[key] || summaryInFlight.has(key) || summaryFailed.has(key)) return
  summaryInFlight.add(key)
  summaryQueue.push({ kind: 'agent', runId, agentId, key })
  pumpSummaries()
}
// Run-level summaries share the queue/cache. Keys: run:<runId>:plan|result.
// Plan is immutable, so plan summaries may be built for live runs; result
// summaries require a terminal record (the route gates on that).
function enqueueRunSummary(runId, kind) {
  const key = 'run:' + runId + ':' + kind
  if (summaries[key] || summaryInFlight.has(key) || summaryFailed.has(key)) return
  summaryInFlight.add(key)
  summaryQueue.push({ kind: 'run-' + kind, runId, key })
  pumpSummaries()
}

// Input assembly for the run-plan summary: meta description + phase titles +
// up to 8 agents as "title: first 200 chars of prompt", capped ~2500 chars.
async function runPlanPrompt(runId) {
  const run = await getRun(runId)
  let description = null, phases = [], agents = []
  if (run.found) {
    try { const s = await getScript(runId); if (s.found) description = parseMetaDescription(s.script) } catch { /* script gone */ }
    if (Array.isArray(run.phases)) phases = run.phases
    try { agents = (await getAgents(runId)).agents } catch { /* journal gone */ }
  } else {
    const detail = await getLiveAgents(runId, { dataDir: DATA_DIR })
    description = detail.description ?? null
    phases = detail.phases ?? []
    agents = detail.agents ?? []
  }
  const parts = []
  if (description) parts.push('Description: ' + description)
  const titles = phases.map(p => typeof p === 'string' ? p : p?.title).filter(Boolean)
  if (titles.length) parts.push('Phases: ' + titles.join('; '))
  for (const a of agents.slice(0, 8)) {
    const name = a.title ?? a.label ?? a.agentId
    const pv = String(a.promptPreview ?? '').slice(0, 200)
    parts.push(pv ? name + ': ' + pv : String(name))
  }
  const input = tidy(parts.join('\n')).slice(0, 2500)
  if (!input.trim()) throw new Error('no plan data')
  return 'In 1-2 plain sentences, present tense, no preamble: what is this multi-agent workflow doing and how is the work divided?\n\n' + input
}

// Input assembly for the run-result summary: record summary + resultSections
// texts (fallback: resultPreview), capped ~3000 chars.
async function runResultPrompt(runId) {
  const run = await getRun(runId)
  if (!run.found) throw new Error('no record')
  const parts = []
  if (run.summary) parts.push('Goal: ' + run.summary)
  const secs = Array.isArray(run.resultSections) ? run.resultSections : []
  for (const s of secs) if (s && s.text) parts.push((s.key ? s.key + ': ' : '') + s.text)
  if (!secs.length && run.resultPreview) parts.push(run.resultPreview)
  const input = tidy(parts.join('\n')).slice(0, 3000)
  if (!input.trim()) throw new Error('no result data')
  return 'In 2-3 plain sentences, past tense, no preamble: what did this workflow conclude or produce?\n\n' + input
}

async function buildSummaryPrompt({ kind, runId, agentId }) {
  if (kind === 'run-plan') return runPlanPrompt(runId)
  if (kind === 'run-result') return runResultPrompt(runId)
  const ag = await getAgents(runId)
  const agent = ag.agents.find(a => a.agentId === agentId)
  const goal = agent ? ((agent.transcriptPath ? await readTranscriptPrompt(agent.transcriptPath) : null) ?? agent.promptPreview ?? null) : null
  if (!goal) throw new Error('no goal text')
  return 'In one plain-language sentence (max 25 words), present tense, say what this agent is doing. No preamble. Task: ' + tidy(goal).slice(0, 2000)
}

// concurrency 1: at most one claude process at a time
async function pumpSummaries() {
  if (summaryPumping) return
  summaryPumping = true
  while (summaryQueue.length) {
    const item = summaryQueue.shift()
    try {
      summaries[item.key] = await summarizeViaCli(await buildSummaryPrompt(item))
      await persistSummaries()
    } catch { summaryFailed.add(item.key) }   // never crash the server; log nothing (goals may hold secrets)
    summaryInFlight.delete(item.key)
  }
  summaryPumping = false
}

// ── IDE theme: follow Cursor/VS Code's workbench.colorTheme so the page
// feels native to the editor rather than keying off OS dark mode ──
const IDE_SETTINGS = [
  ['cursor', path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'settings.json')],
  ['vscode', path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json')],
]
async function ideTheme() {
  for (const [source, f] of IDE_SETTINGS) {
    try {
      const raw = await fs.readFile(f, 'utf8')
      const m = raw.match(/"workbench\.colorTheme"\s*:\s*"([^"]+)"/)
      const theme = m ? m[1] : null
      // Name heuristic: most themes are dark unless they say otherwise.
      const mode = theme && /light|latte|dawn|daylight|quiet light|solarized light/i.test(theme) ? 'light' : 'dark'
      return { theme, mode, source }
    } catch { /* try next IDE */ }
  }
  return { theme: null, mode: null, source: null }
}
for (const [, f] of IDE_SETTINGS) {
  try { watch(f, () => broadcast('theme')) } catch { /* absent IDE */ }
}

// ── watcher: one recursive watch on the projects root + rescan fallback ──
function broadcast(type) {
  for (const res of sseClients) res.write(`event: ${type}\ndata: ${Date.now()}\n\n`)
}
let debounce = null
try {
  watch(DEFAULT_PROJECTS_DIR, { recursive: true }, (_e, file) => {
    if (!file || !/workflows/.test(file)) return
    clearTimeout(debounce)
    debounce = setTimeout(() => broadcast('change'), 750)
  })
} catch { /* projects dir may not exist yet; rescan timer still covers it */ }
setInterval(() => broadcast('tick'), 60_000).unref()

setInterval(() => {
  if (sseClients.size === 0 && Date.now() - lastActivity > IDLE_LIMIT_MS) process.exit(0)
}, 60_000).unref()

function authorized(req, url) {
  if (url.searchParams.get('t') !== TOKEN) return false
  const host = (req.headers.host || '').split(':')[0]
  if (host !== '127.0.0.1' && host !== 'localhost') return false
  const origin = req.headers.origin
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return false
  return true
}

const json = (res, body, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const authed = authorized(req, url)
  // Only authorized traffic counts as activity — otherwise unauthenticated
  // /health pings could hold the server open past the idle limit forever.
  if (authed) lastActivity = Date.now()
  if (url.pathname === '/health') return json(res, { ok: authed, name: 'conductor-dashboard', version: VERSION, pid: process.pid })
  if (!authed) {
    // A stale tab (rotated/wrong token) should see words, not silent JSON.
    if (url.pathname === '/' ) {
      res.writeHead(401, { 'content-type': 'text/html' })
      return res.end('<body style="font:14px ui-sans-serif;padding:40px;color:#444"><h3>Workflows Conductor — link expired</h3>This dashboard link\'s token is no longer valid (the dashboard restarted with a new one). Run <code>/conductor:dashboard</code> in any Claude Code session to open a fresh link.</body>')
    }
    return json(res, { error: 'unauthorized' }, 401)
  }

  try {
    // no-store: Simple Browser/embedded webviews cache aggressively; a stale
    // page after a dashboard upgrade looks like broken features.
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); return res.end(PAGE) }
    if (url.pathname === '/api/runs') {
      const runs = await listRuns({ scope: 'all', limit: Number(url.searchParams.get('limit') || 100) })
      const hookLive = await liveFromHookEvents({ recordedIds: new Set(runs.runs.map(r => r.runId)) })
      return json(res, { ...runs, hookLive })
    }
    if (url.pathname === '/api/live') return json(res, await liveState())
    if (url.pathname === '/api/theme') return json(res, await ideTheme())
    if (url.pathname.startsWith('/api/tail/')) {
      // No client-supplied paths: runId+agentId only; the transcript path is
      // resolved by the reader inside ~/.claude/projects by construction.
      const [, , , runId, agentId] = url.pathname.split('/')
      if (!/^wf_[A-Za-z0-9-]+$/.test(runId ?? '') || !/^[A-Za-z0-9]+$/.test(agentId ?? '')) {
        return json(res, { error: 'bad runId/agentId' }, 400)
      }
      const ag = await getAgents(runId)
      const agent = ag.agents.find(a => a.agentId === agentId)
      if (!agent?.transcriptPath) return json(res, { error: 'no transcript for that agent' }, 404)
      const goal = (await readTranscriptPrompt(agent.transcriptPath)) ?? agent.promptPreview
      return json(res, { runId, agentId, goal, label: agent.label ?? null, title: agent.title ?? deriveTitle(agent.label ?? null, goal ?? null), ...(await parseTranscriptTail(agent.transcriptPath)) })
    }
    if (url.pathname.startsWith('/api/summary/')) {
      // Same id discipline as /api/tail — never a client-supplied path.
      const [, , , runId, agentId] = url.pathname.split('/')
      if (!/^wf_[A-Za-z0-9-]+$/.test(runId ?? '') || !/^[A-Za-z0-9]+$/.test(agentId ?? '')) {
        return json(res, { error: 'bad runId/agentId' }, 400)
      }
      const key = runId + '/' + agentId
      if (summaries[key]) return json(res, { state: 'ready', summary: summaries[key] })
      if (summaryFailed.has(key)) return json(res, { state: 'error' })
      enqueueSummary(runId, agentId)
      return json(res, { state: 'pending' })
    }
    if (url.pathname.startsWith('/api/runsummary/')) {
      // Same id discipline; kind is a strict whitelist.
      const [, , , runId, kind] = url.pathname.split('/')
      if (!/^wf_[A-Za-z0-9-]+$/.test(runId ?? '') || (kind !== 'plan' && kind !== 'result')) {
        return json(res, { error: 'bad runId/kind' }, 400)
      }
      const key = 'run:' + runId + ':' + kind
      if (summaries[key]) return json(res, { state: 'ready', summary: summaries[key] })
      if (summaryFailed.has(key)) return json(res, { state: 'error' })
      // Result summaries only exist once a terminal record does; not an error —
      // the run may simply still be in flight.
      if (kind === 'result' && !(await getRun(runId)).found) return json(res, { state: 'unavailable' })
      enqueueRunSummary(runId, kind)
      return json(res, { state: 'pending' })
    }
    if (url.pathname.startsWith('/api/run/')) {
      const run = await getRun(url.pathname.split('/')[3])
      // Augment with the workflow's meta description (the record itself only
      // carries the goal summary) — the run panel's plan block shows it.
      if (run.found && run.description === undefined) {
        try { const s = await getScript(run.runId); run.description = s.found ? parseMetaDescription(s.script) : null } catch { run.description = null }
      }
      return json(res, run)
    }
    if (url.pathname.startsWith('/api/agents/')) return json(res, await getAgents(url.pathname.split('/')[3]))
    if (url.pathname === '/shutdown' && req.method === 'POST') { json(res, { bye: true }); return setTimeout(() => process.exit(0), 50) }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write('event: hello\ndata: 1\n\n')
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }
    return json(res, { error: 'not found' }, 404)
  } catch (err) {
    return json(res, { error: String(err?.message || err) }, 500)
  }
})

const PAGE = /* html */ `<!doctype html><html><head><meta charset="utf-8"><title>Workflows Conductor</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#fff;--fg:#1a1a1a;--mut:#6b7280;--line:#e5e7eb;--card:#f9fafb;--acc:#4f46e5;--ok:#059669;--bad:#dc2626;--warn:#d97706}
@media(prefers-color-scheme:dark){:root{--bg:#181818;--fg:#e5e7eb;--mut:#9ca3af;--line:#2a2a2a;--card:#1f1f1f;--acc:#818cf8;--ok:#34d399;--bad:#f87171;--warn:#fbbf24}}
:root[data-theme=light]{--bg:#fff;--fg:#1a1a1a;--mut:#6b7280;--line:#e5e7eb;--card:#f9fafb;--acc:#4f46e5;--ok:#059669;--bad:#dc2626;--warn:#d97706}
:root[data-theme=dark]{--bg:#181818;--fg:#e5e7eb;--mut:#9ca3af;--line:#2a2a2a;--card:#1f1f1f;--acc:#818cf8;--ok:#34d399;--bad:#f87171;--warn:#fbbf24}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 ui-sans-serif,system-ui;background:var(--bg);color:var(--fg);overflow-x:hidden}
header{display:flex;gap:12px;align-items:center;padding:12px 20px;border-bottom:1px solid var(--line);flex-wrap:wrap}
h1{font-size:16px;margin:0}#totals{color:var(--mut)}
#filter{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font:inherit;font-size:13px;width:220px}
label.tog{display:inline-flex;gap:5px;align-items:center;color:var(--mut);font-size:12px;cursor:pointer;user-select:none}
#dot{width:8px;height:8px;border-radius:50%;background:var(--mut);display:inline-block;margin-left:auto}
#dot.live{background:var(--ok)}
main{display:block}
section{overflow:auto;min-width:0;padding:0 0 8px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
th{color:var(--mut);font-weight:500;font-size:12px;position:sticky;top:0;background:var(--bg);cursor:pointer;user-select:none}
tr.run{cursor:pointer}
tr.run:hover{background:color-mix(in srgb,var(--card) 55%,var(--bg))}
tr.sel,tr.sel:hover{background:color-mix(in srgb,var(--acc) 10%,var(--bg))}
tr.sel td:first-child{box-shadow:inset 2px 0 var(--acc)}
tr.grp td{cursor:pointer;user-select:none;background:var(--card);color:var(--mut);font-size:12px;font-weight:600;max-width:none}
.s{padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line)}
.s.completed{color:var(--ok)}.s.killed,.s.unreadable{color:var(--bad)}.s.live{color:var(--ok);border-color:var(--ok)}.s.stale{color:var(--warn)}.s.unk{color:var(--warn)}
#detail{position:fixed;top:0;right:0;bottom:0;width:460px;max-width:100vw;background:var(--bg);border-left:1px solid var(--line);box-shadow:-6px 0 24px rgba(0,0,0,.18);z-index:20;display:none}
#detail.open{display:flex;flex-direction:column}
#dhead{display:flex;align-items:flex-start;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line)}
#dtitle{flex:1;min-width:0}
#dbody{flex:1;overflow-y:auto;overflow-x:hidden;padding:12px 16px}
#dfoot{border-top:1px solid var(--line);padding:10px 16px;background:var(--card)}
#dfoot:empty{display:none}
#close{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;width:26px;height:26px;cursor:pointer;font:inherit;line-height:1;flex:none}
#detail h2{font-size:14px;margin:0 0 4px}#detail .mut{color:var(--mut);font-size:12px}
.agent{padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin:8px 0;background:var(--card)}
.agent b{font-size:12px}.agent .mut{display:block;font-size:11px;word-break:break-all}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;white-space:pre-wrap;word-break:break-word;font-size:12px;max-height:280px;overflow:auto}
.pdot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px;background:var(--mut)}
.pdot.on{background:var(--ok);animation:pulse 1.2s ease-in-out infinite}
.pdot.stall{background:var(--warn)}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.75)}}
tr.sub td{padding:4px 10px;border-bottom:1px dashed var(--line);background:color-mix(in srgb,var(--card) 60%,var(--bg));font-size:12px;cursor:pointer;max-width:none}
tr.sub td:first-child{padding-left:26px}
tr.sub:hover td{background:var(--card)}
tr.sub .act{color:var(--mut);font-size:11px}
.tev{border-left:2px solid var(--line);padding:2px 8px;margin:4px 0;font-size:12px;overflow-wrap:anywhere}
.tev .tool{color:var(--acc)}.tev .badge{display:block;overflow-wrap:anywhere}
.badge{font-size:11px;color:var(--mut)}
section,#dbody,pre,.goal{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--mut) 30%,transparent) transparent}
section::-webkit-scrollbar,#dbody::-webkit-scrollbar,pre::-webkit-scrollbar{width:8px;height:8px;background:transparent}
section::-webkit-scrollbar-thumb,#dbody::-webkit-scrollbar-thumb,pre::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--mut) 30%,transparent);border-radius:4px}
section::-webkit-scrollbar-thumb:hover,#dbody::-webkit-scrollbar-thumb:hover,pre::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--mut) 55%,transparent)}
section::-webkit-scrollbar-track,#dbody::-webkit-scrollbar-track,pre::-webkit-scrollbar-track{background:transparent}
.xp{cursor:pointer;color:var(--mut);display:inline-block;width:14px}
button.info{cursor:pointer;color:var(--mut);background:transparent;border:0;padding:2px;margin-right:6px;border-radius:5px;display:inline-flex;align-items:center;vertical-align:-3px;opacity:.55}
tr.run:hover button.info{opacity:1}
button.info:hover{color:var(--acc);background:var(--card);opacity:1}
#themec,#aisum{cursor:pointer;background:var(--card);color:var(--mut);border:1px solid var(--line);border-radius:6px;padding:4px 10px;font:inherit;font-size:12px}
.goal{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:8px 0;font-size:12px;word-break:break-word;max-height:132px;overflow-y:auto;white-space:pre-wrap}
.goal b{color:var(--mut);font-size:11px;text-transform:uppercase;margin-right:6px}
.rkey{color:var(--mut);font-size:11px;text-transform:uppercase;font-weight:600;margin:10px 0 2px}
#sf{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden}
#sf button{background:var(--bg);color:var(--mut);border:0;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer}
#sf button.on{background:var(--card);color:var(--fg)}
</style></head><body>
<header><h1>Workflows Conductor</h1><span class="badge" title="dashboard build — if this lags the plugin version, reload the tab">v${VERSION}</span><span id="totals"></span><input id="filter" type="search" placeholder="filter runs…" autocomplete="off"><span id="sf"><button data-f="all" class="on">all</button><button data-f="active">active</button><button data-f="done">finished</button></span><label class="tog"><input type="checkbox" id="grp" checked>group by project</label><button id="aisum" title="one-line Haiku summaries in the agent panel (uses your claude CLI)"></button><button id="themec" title="theme source"></button><span id="dot" title="SSE"></span></header>
<main><section><table><thead><tr id="hdr"></tr></thead><tbody id="rows"></tbody></table></section></main>
<aside id="detail"><div id="dhead"><div id="dtitle"></div><button id="close" title="close (Esc)">✕</button></div><div id="dbody"></div><div id="dfoot"></div></aside>
<script>
const T=new URLSearchParams(location.search).get('t')
const q=p=>fetch(p+(p.includes('?')?'&':'?')+'t='+T).then(r=>r.json())
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const fmt=n=>n==null?'—':n.toLocaleString()
const dur=ms=>ms==null?'—':ms<60000?(ms/1000).toFixed(1)+'s':Math.round(ms/60000)+'m'
const when=ts=>ts?new Date(ts).toLocaleString():'—'
const shortProj=p=>{const s=String(p||'').split('-').filter(Boolean);return s.length?s.slice(-2).join('-'):'(no project)'}
const shortRun=id=>String(id).replace(/^wf_/,'').slice(0,8)
const shortAg=id=>String(id).slice(0,8)
const nameCell=(name,idShort)=>(name?esc(name)+' ':'')+'<span class="badge">('+esc(idShort)+')</span>'
// ── write-on-change panel regions: identical HTML is never rewritten, so a
// static goal is written once per agent and its scroll can never reset ──
const lastHtml=new Map()
function setHtml(id,html){const el=document.getElementById(id);if(!el)return false;if(lastHtml.get(id)===html)return false;el.innerHTML=html;lastHtml.set(id,html);return true}
// AI summaries: default on; sumCache holds /api/summary responses per run/agent
let aiOn=localStorage.getItem('aiSum')!=='off'
const sumCache=new Map()
// Pending-summary pollers: while a panel shows a pending summary, poll its
// endpoint on a dedicated 2.5s loop (cap ~120s -> 'summary unavailable'),
// independent of live-refresh cycles. Cleared on panel close/switch.
const sumPolls=new Map() // key -> {timer,started}
function stopSumPolls(){for(const p of sumPolls.values())clearTimeout(p.timer);sumPolls.clear()}
function needSum(key){const c=sumCache.get(key);return !c||c.state==='pending'||c.state==='unavailable'}
function pollSummary(key,url,onDone){
  if(sumPolls.has(key))return
  const st={started:Date.now(),timer:null}
  sumPolls.set(key,st)
  const poll=async()=>{
    if(sumPolls.get(key)!==st)return
    let r=null;try{r=await q(url)}catch{}
    if(sumPolls.get(key)!==st)return
    if(r&&r.state)sumCache.set(key,r)
    if(r&&r.state&&r.state!=='pending'&&r.state!=='unavailable'){sumPolls.delete(key);onDone();return}
    if(Date.now()-st.started>120000){sumCache.set(key,{state:'timeout'});sumPolls.delete(key);onDone();return}
    st.timer=setTimeout(poll,2500)
  }
  poll()
}
// One-line AI summary state -> HTML, shared by agent and run panels.
function aiLine(key,label){
  const c=sumCache.get(key)
  if(c&&c.state==='ready')return '<div><span class="badge">'+label+':</span> '+esc(c.summary)+'</div>'
  if(c&&(c.state==='error'||c.state==='timeout'))return '<div class="badge">'+label+': summary unavailable</div>'
  if(c&&c.state==='unavailable')return ''
  return '<div class="badge">'+label+': …</div>'
}
const INFO_BTN='<button class="info" title="run summary"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="7.2" y="6.8" width="1.6" height="4.6" rx=".8" fill="currentColor"/><circle cx="8" cy="4.6" r="1" fill="currentColor"/></svg></button>'
// ── theme: follow the IDE (Cursor/VS Code) by default, manual override cycles ──
let themePref=localStorage.getItem('themePref')||'ide'   // ide | light | dark
async function applyTheme(){
  const root=document.documentElement,btn=document.getElementById('themec')
  if(themePref==='ide'){
    try{
      const t=await q('/api/theme')
      if(t.mode){root.dataset.theme=t.mode;btn.textContent='theme: '+t.source+' ('+t.mode+')';btn.title=t.theme||'';return}
    }catch{}
    delete root.dataset.theme;btn.textContent='theme: os'
  }else{root.dataset.theme=themePref;btn.textContent='theme: '+themePref}
}
// UI state lives here at module level; refresh() only swaps data and re-renders,
// so sort/filter/grouping/collapsed/selection all survive SSE-triggered refreshes.
let sel=null,sortKey='timestamp',sortDir=-1,filter='',statusFilter='all',groupOn=true,data=null
const collapsed=new Set()
const expanded=new Set(),agentsCache=new Map(),agFetching=new Set()
async function ensureAgents(runId){
  if(agentsCache.has(runId)||agFetching.has(runId))return
  agFetching.add(runId)
  try{const r=await q('/api/agents/'+encodeURIComponent(runId));if(Array.isArray(r.agents))agentsCache.set(runId,r.agents)}catch{}
  agFetching.delete(runId);render()
}
const COLS=[['name','name'],['status','status'],['agentCount','agents'],['totalTokens','tokens'],['durationMs','dur'],['defaultModel','model'],['timestamp','when'],['projectDir','project']]
const shortModel=m=>m?String(m).replace(/^claude-/,''):''
const NUM=new Set(['agentCount','totalTokens','durationMs'])
function cmp(a,b){
  if(sortKey==='name'){ // merged column: workflowName first, runId breaks ties
    const wx=String(a.workflowName??'').toLowerCase(),wy=String(b.workflowName??'').toLowerCase()
    if(wx!==wy)return (wx<wy?-1:1)*sortDir
    const rx=String(a.runId),ry=String(b.runId)
    return (rx<ry?-1:rx>ry?1:0)*sortDir
  }
  let x=a[sortKey],y=b[sortKey]
  if(sortKey==='timestamp'){x=new Date(x??0).getTime()||0;y=new Date(y??0).getTime()||0;return (x-y)*sortDir}
  if(NUM.has(sortKey)){x=x==null?-Infinity:+x;y=y==null?-Infinity:+y;return (x-y)*sortDir}
  x=String(x??'').toLowerCase();y=String(y??'').toLowerCase()
  return (x<y?-1:x>y?1:0)*sortDir
}
// Live runs become ordinary table rows (status running/live?/stale); their
// per-agent detail renders as indented sub-rows directly beneath.
function liveRows(){
  if(!live||!Array.isArray(live.active))return []
  const rows=[]
  for(const r of live.active){
    const agents=r.agents||[]
    const status=(r.source==='stale'?'stale (interrupted?)':'running')+(r.resumedAfter?' (resumed after '+r.resumedAfter+')':'')
    rows.push({
      runId:r.runId,workflowName:r.name??null,status,statusRecognized:true,compat:'ok',
      agentCount:agents.length||null,
      totalTokens:agents.reduce((s,a)=>s+(a.outputTokens||0),0)||null,
      durationMs:Math.max(0,...agents.map(a=>a.elapsedMs||0))||null,
      defaultModel:agents.map(a=>a.model).find(Boolean)??null,
      timestamp:r.lastActivity??new Date(liveAt).toISOString(),
      projectDir:r.projectDir??null,isLive:true,agents,
    })
  }
  for(const u of (live.unattributed||[])){
    rows.push({runId:u.taskId,workflowName:u.name??null,status:'running (id pending)',statusRecognized:true,compat:'ok',
      agentCount:null,totalTokens:null,durationMs:null,timestamp:u.seenAt??new Date(liveAt).toISOString(),projectDir:null,isLive:true,agents:[],noPick:true})
  }
  return rows
}
function rowHtml(r){
  const drift=Date.now()-liveAt
  const cls=r.isLive?(r.status.startsWith('stale')?'stale':'live'):(r.status==='completed'?'completed':(r.statusRecognized?'killed':'unk'))
  const warn=r.compat!=='ok'?' <span class="badge">⚠ '+esc(r.compat)+'</span>':''
  const durCell=r.isLive?'<td class="ldur" data-base="'+(r.durationMs??0)+'">'+(r.durationMs!=null?ago(r.durationMs+drift):'—')+'</td>':'<td>'+dur(r.durationMs)+'</td>'
  let html='<tr class="run'+(sel===r.runId?' sel':'')+(r.isLive?' lrun':'')+'" data-id="'+esc(r.runId)+'"'+(r.noPick?' data-nopick="1"':'')+'><td>'+(r.isLive?'<span class="pdot on"></span>':(r.agentCount?'<span class="xp">'+(expanded.has(r.runId)?'▾':'▸')+'</span>':''))+(r.noPick?'':INFO_BTN)+nameCell(r.workflowName??'—',shortRun(r.runId))+warn+'</td><td><span class="s '+cls+'">'+esc(r.status)+'</span></td><td>'+fmt(r.agentCount)+'</td><td>'+fmt(r.totalTokens)+'</td>'+durCell+'<td class="badge">'+esc(shortModel(r.defaultModel))+'</td><td>'+when(r.timestamp)+'</td><td class="badge">'+esc(r.projectDir??'')+'</td></tr>'
  // Agent sub-rows use the SAME columns as runs. Live rows always show them;
  // finished rows expand on demand (agents fetched lazily into agentsCache).
  if(r.isLive)for(const a of r.agents)html+=subRowHtml(r.runId,a,drift)
  else if(expanded.has(r.runId)){
    const ags=agentsCache.get(r.runId)
    if(ags)for(const a of ags)html+=subRowHtml(r.runId,a,0)
    else html+='<tr class="sub"><td colspan=8 class="badge">loading agents…</td></tr>'
  }
  return html
}
function subRowHtml(runId,a,drift){
  const b=agentBadge(a,drift)
  const tok=a.outputTokens??a.tokens
  const durMs=a.elapsedMs??a.durationMs
  return '<tr class="sub" data-run="'+esc(runId)+'" data-agent="'+esc(a.agentId)+'">'+
    '<td><span class="'+b.dot+'"></span>'+nameCell(a.title??a.label??null,shortAg(a.agentId))+'</td>'+
    '<td><span class="s '+b.statusCls+' ast">'+esc(b.statusText)+'</span></td>'+
    '<td></td>'+
    '<td>'+(tok!=null?fmt(tok):'')+'</td>'+
    '<td class="adur" data-base="'+(a.elapsedMs??'')+'" data-run-state="'+(b.running?'1':'')+'">'+(durMs!=null?(b.running?ago(b.elapsed):dur(durMs)):'')+'</td>'+
    '<td class="badge">'+esc(shortModel(a.model))+'</td>'+
    '<td>'+(a.lastActivityAt?when(a.lastActivityAt):'')+'</td>'+
    '<td></td></tr>'
}
function render(){
  if(!data&&!live)return
  document.getElementById('hdr').innerHTML=COLS.map(c=>'<th data-k="'+c[0]+'">'+c[1]+(sortKey===c[0]?(sortDir>0?' ▲':' ▼'):'')+'</th>').join('')
  const nErr=((data&&data.errors)||[]).length
  if(data)document.getElementById('totals').textContent=data.totalRuns+' runs · '+data.projectCount+' projects'+(nErr?' · '+nErr+' unreadable':'')
  const lv=liveRows()
  const liveIds=new Set(lv.map(r=>r.runId))
  const recorded=((data&&data.runs)||[]).filter(r=>!liveIds.has(r.runId))  // race guard: never both
  const f=filter.trim().toLowerCase()
  const runs=[...lv,...recorded]
    .filter(r=>statusFilter==='all'||(statusFilter==='active')===(!!r.isLive))
    .filter(r=>{ // matches full runId/name AND any agent's full id/title/label
      if(!f)return true
      if([r.runId,r.workflowName,r.status,r.projectDir].some(v=>String(v??'').toLowerCase().includes(f)))return true
      const ags=r.isLive?(r.agents||[]):(agentsCache.get(r.runId)||[])
      return ags.some(a=>[a.agentId,a.title,a.label].some(v=>String(v??'').toLowerCase().includes(f)))
    })
    .sort(cmp)
  let html=''
  if(groupOn){
    const groups=new Map()
    for(const r of runs){const k=r.projectDir??'';(groups.get(k)??groups.set(k,[]).get(k)).push(r)}
    for(const [k,rs] of groups){
      const open=!collapsed.has(k)||rs.some(r=>r.isLive)   // never hide a live run behind a collapsed group
      html+='<tr class="grp" data-gk="'+esc(k)+'"><td colspan=8>'+(open?'▾ ':'▸ ')+esc(shortProj(k))+' <span class="badge">('+rs.length+' run'+(rs.length===1?'':'s')+')</span></td></tr>'
      if(open)html+=rs.map(rowHtml).join('')
    }
  }else html=runs.map(rowHtml).join('')
  const emptyMsg=statusFilter==='active'?'No active runs right now':(((data&&data.runs)||[]).length?'No runs match the filter':'No workflow runs found — launch one with an ultracode: prompt (CLI ≥ 2.1.154)')
  document.getElementById('rows').innerHTML=html||'<tr><td colspan=8 class="badge">'+emptyMsg+'</td></tr>'
}
// ── Active Runs (F2/F4): fed by /api/live, elapsed ticks locally between polls ──
let live=null,liveAt=0,selTail=null
const ago=ms=>{if(ms==null)return '—';const s=Math.max(0,Math.round(ms/1000));return s<60?s+'s':Math.floor(s/60)+'m '+(s%60)+'s'}
function actionText(a){
  if(!a)return 'no activity seen yet'
  if(a.kind==='tool')return a.tool+' '+(a.summary??'')
  return (a.snippet??'').slice(0,120)
}
// Agent presentation parts, shared by full render and in-place tick.
function agentBadge(a,drift){
  const running=a.state==='running'
  const unknown=a.state!=='running'&&a.state!=='done'
  const quiet=a.quietMs==null?null:a.quietMs+drift
  const stalled=running&&quiet!=null&&quiet>120000
  const fresh=running&&quiet!=null&&quiet<10000
  const elapsed=a.elapsedMs==null?null:a.elapsedMs+(running?drift:0)
  return {
    dot:stalled?'pdot stall':(fresh?'pdot on':'pdot'),
    statusText:unknown?'unknown':(running?(stalled?'quiet '+ago(quiet)+(quiet>600000?' — stalled or killed?':' — stalled?'):'running'):'done'),
    statusCls:unknown?'unk':(running?(stalled?'stale':'live'):'completed'),
    elapsed,running,
  }
}
// 1s ticker: update timer text/dots IN PLACE. Never innerHTML — a DOM swap
// mid-click eats the click, and swaps restart the pulse animation.
function tickLive(){
  if(!live||!Array.isArray(live.active)||!live.active.length)return
  const drift=Date.now()-liveAt
  const byKey=new Map()
  for(const r of live.active)for(const a of (r.agents||[]))byKey.set(r.runId+'/'+a.agentId,a)
  for(const row of document.querySelectorAll('#rows tr.sub')){
    const a=byKey.get(row.dataset.run+'/'+row.dataset.agent)
    if(!a)continue
    const b=agentBadge(a,drift)
    const st=row.querySelector('.ast'),dot=row.querySelector('[class^="pdot"],.pdot'),ad=row.querySelector('.adur')
    if(st&&st.textContent!==b.statusText){st.textContent=b.statusText;st.className='s '+b.statusCls+' ast'}
    if(dot&&dot.className!==b.dot)dot.className=b.dot
    if(ad&&b.running&&b.elapsed!=null)ad.textContent=ago(b.elapsed)
  }
  for(const td of document.querySelectorAll('#rows td.ldur'))td.textContent=ago(Number(td.dataset.base)+drift)
}
// in-flight dedupe + min interval: SSE storms during active runs must not
// stack overlapping polls of an expensive endpoint
let liveBusy=false
async function refreshLive(force){
  if(liveBusy)return
  if(!force&&Date.now()-liveAt<2000)return
  liveBusy=true
  try{
    const d=await q('/api/live')
    if(d&&Array.isArray(d.active)){live=d;liveAt=Date.now()}
    render()
    if(selTail)loadTail(selTail.runId,selTail.agentId)
    if(sel)loadDetail(sel)   // keeps the in-flight macro panel current
  }catch{}finally{liveBusy=false}
}
// Mechanical status line (instant, from tail data) + AI sentence once ready.
// Only truthy segments joined with ' · ' — no stray leading/trailing dots when
// stats or timestamps are missing.
function sumHtml(t,runId,agentId){
  const parts=[esc(t.title??t.label??'agent')]
  if(t.stats&&t.stats.toolCounts){
    const entries=Object.entries(t.stats.toolCounts).sort((x,y)=>y[1]-x[1])
    const total=entries.reduce((s,e)=>s+e[1],0)
    const top=entries.slice(0,2).map(e=>e[0]).join(', ')
    parts.push(total+' tool call'+(total===1?'':'s')+(top?' ('+top+')':''))
  }
  if(t.lastTimestamp)parts.push('last active '+ago(Date.now()-new Date(t.lastTimestamp).getTime())+' ago')
  let h='<div class="goal"><b>summary</b>'+parts.filter(Boolean).join(' · ')
  if(aiOn)h+=aiLine(runId+'/'+agentId,'AI summary')
  return h+'</div>'
}
async function loadTail(runId,agentId){
  const t=await q('/api/tail/'+encodeURIComponent(runId)+'/'+encodeURIComponent(agentId))
  if(!selTail||selTail.runId!==runId||selTail.agentId!==agentId)return
  const evs=(t.events||[]).map(e=>{
    if(e.kind==='tool')return '<div class="tev"><span class="tool">'+esc(e.tool)+'</span> <span class="badge">'+esc(e.summary??'')+'</span></div>'
    if(e.kind==='text')return '<div class="tev">'+esc(e.snippet??'')+'</div>'
    return '<div class="tev badge">↳ tool result</div>'
  }).join('')
  setHtml('dtitle','<h2>'+esc(t.title??t.label??'agent')+' <span class="badge">('+esc(shortAg(agentId))+')</span></h2><div class="mut">'+esc(runId)+' · '+esc(agentId.slice(0,10))+'…'+
    (t.model?' · '+esc(String(t.model).replace(/^claude-/,'')):'')+(t.outputTokens?' · '+fmt(t.outputTokens)+' output tok (window)':'')+'</div>')
  // dfoot splits into two independently-tracked regions: the summary line may
  // tick every refresh, but the goal block below it is written once per agent
  // so its scroll position survives feed refreshes.
  if(lastHtml.get('dfoot')!=='::split::'){document.getElementById('dfoot').innerHTML='<div id="dsum"></div><div id="dgoal"></div>';lastHtml.set('dfoot','::split::');lastHtml.delete('dsum');lastHtml.delete('dgoal')}
  setHtml('dsum',sumHtml(t,runId,agentId))
  setHtml('dgoal',t.goal?'<div class="goal"><b>goal</b>'+esc(t.goal)+'</div>':'')
  if(aiOn){const k=runId+'/'+agentId
    if(needSum(k))pollSummary(k,'/api/summary/'+encodeURIComponent(runId)+'/'+encodeURIComponent(agentId),()=>{
      if(selTail&&selTail.runId===runId&&selTail.agentId===agentId)setHtml('dsum',sumHtml(t,runId,agentId))
    })}
  const body=document.getElementById('dbody')
  const nearBottom=body.scrollHeight-body.scrollTop-body.clientHeight<80
  const hadContent=!!body.querySelector('.tev')
  // write-on-change: identical feed HTML is left alone (scroll untouched)
  if(setHtml('dbody',evs||'<span class="badge">no parsed events in the tail window yet</span>')&&(!hadContent||nearBottom))body.scrollTop=body.scrollHeight   // chat-style: follow the newest unless reading back
}
async function refresh(){
  data=await q('/api/runs')
  render()
  if(sel)loadDetail(sel)
}
function pick(id){
  stopSumPolls();selTail=null;sel=id;render()
  document.getElementById('detail').classList.add('open')
  setHtml('dtitle','<h2>'+esc(id)+'</h2>')
  setHtml('dbody','<span class="badge">loading…</span>')
  setHtml('dfoot','')
  document.getElementById('dbody').scrollTop=0
  loadDetail(id)
}
function pickTail(runId,agentId){
  stopSumPolls();sel=null;selTail={runId,agentId};render()
  // instant feedback: open with a placeholder before the fetch resolves
  document.getElementById('detail').classList.add('open')
  setHtml('dtitle','<h2>agent <span class="badge">('+esc(shortAg(agentId))+')</span></h2><div class="mut">'+esc(runId)+'</div>')
  setHtml('dbody','<span class="badge">loading agent feed…</span>')
  setHtml('dfoot','')
  loadTail(runId,agentId)
}
function closeDrawer(){if(sel==null&&selTail==null)return;stopSumPolls();sel=null;selTail=null;document.getElementById('detail').classList.remove('open');render()}
// Run summary panel (ⓘ icon): ONE anatomy for live and finished runs.
// Body = PLAN block (AI plan line · description · phase list · agent roster),
// finished runs append a RESULT block (AI result line · labeled sections).
// Footer stays the goal/description block.
function rosterHtml(agents,drift,liveMode){
  if(!agents.length)return '<div class="badge">no agents seen yet</div>'
  let h=''
  for(const a of agents){
    const b=agentBadge(a,drift)
    const tok=a.outputTokens??a.tokens
    h+='<div class="agent"><span class="'+b.dot+'"></span><b>'+nameCell(a.title??a.label??null,shortAg(a.agentId))+'</b> <span class="s '+b.statusCls+'">'+esc(b.statusText)+'</span>'+
      (tok!=null?' <span class="badge">'+fmt(tok)+' tok</span>':'')+
      (liveMode?'<span class="mut" style="white-space:nowrap;word-break:normal;overflow:hidden;text-overflow:ellipsis">'+esc(actionText(a.currentAction))+'</span>':'')+'</div>'
  }
  return h
}
function planHtml(runId,desc,phases,agents,drift,liveMode){
  let h='<div class="goal"><b>plan</b>'
  if(aiOn)h+=aiLine('run:'+runId+':plan','AI')
  if(desc)h+='<div>'+esc(desc)+'</div>'
  const ph=Array.isArray(phases)?phases:[]
  if(ph.length){
    const act=(agents||[]).filter(a=>a.state==='running').sort((x,y)=>new Date(y.lastActivityAt||0)-new Date(x.lastActivityAt||0))
    const cur=liveMode?((act[0]&&act[0].phaseTitle)||null):null
    h+=ph.map(p=>{const ti=typeof p==='string'?p:(p&&p.title)||'?';const on=liveMode&&cur===ti;return '<div'+(on?' style="color:var(--acc)"':' class="badge"')+'>'+(on?'▶ ':'· ')+esc(ti)+'</div>'}).join('')
  }
  h+='</div>'
  return h+rosterHtml(agents||[],drift,liveMode)
}
function resultHtml(run){
  let h='<div class="goal"><b>result</b>'
  if(aiOn)h+=aiLine('run:'+run.runId+':result','AI')
  h+='</div>'
  const secs=Array.isArray(run.resultSections)?run.resultSections.filter(s=>s&&(s.text||s.key)):[]
  if(secs.length)for(const s of secs)h+=(s.key?'<div class="rkey">'+esc(s.key)+'</div>':'')+'<pre>'+esc(s.text??'')+(s.truncated?'\\n… (truncated)':'')+'</pre>'
  else if(run.resultPreview)h+='<pre>'+esc(run.resultPreview)+(run.resultTruncated?'\\n… (truncated)':'')+'</pre>'
  else h+='<span class="badge">no result recorded</span>'
  return h
}
async function loadDetail(id){
  const run=await q('/api/run/'+encodeURIComponent(id))
  if(sel!==id)return
  // Plan is immutable, so its summary may be requested even while live.
  if(aiOn&&needSum('run:'+id+':plan'))pollSummary('run:'+id+':plan','/api/runsummary/'+encodeURIComponent(id)+'/plan',()=>{if(sel===id)loadDetail(id)})
  if(run.found===false){
    // recordless = in flight: render the live macro view from /api/live
    // (cached server-side), not a one-line cop-out
    let lr=null
    try{const d=await q('/api/live');if(d&&Array.isArray(d.active))lr=d.active.find(x=>x.runId===id)||null}catch{}
    if(sel!==id)return
    if(lr){
      const n=(lr.agents||[]).length
      setHtml('dtitle','<h2>'+esc(lr.name??'—')+' <span class="badge">('+esc(shortRun(id))+')</span></h2><div class="mut">in flight · '+n+' agent'+(n===1?'':'s')+'</div>')
      setHtml('dbody',planHtml(id,lr.description,lr.phases,lr.agents||[],Date.now()-liveAt,true))
      setHtml('dfoot',lr.description?'<div class="goal"><b>goal</b>'+esc(lr.description)+'</div>':'')
    }else{
      setHtml('dtitle','<h2>'+esc(id)+'</h2><div class="mut">in flight — no terminal record yet</div>')
      setHtml('dbody','<span class="badge">expand the row to see live agents</span>')
      setHtml('dfoot','')
    }
    return
  }
  if(aiOn&&needSum('run:'+id+':result'))pollSummary('run:'+id+':result','/api/runsummary/'+encodeURIComponent(id)+'/result',()=>{if(sel===id)loadDetail(id)})
  // Roster for finished runs comes from the shared agentsCache (lazy fetch).
  if(!agentsCache.has(id)){
    if(agFetching.has(id))setTimeout(()=>{if(sel===id&&!agentsCache.has(id))loadDetail(id)},500)
    else ensureAgents(id).then(()=>{if(sel===id&&agentsCache.has(id))loadDetail(id)})   // has() guard: a failed fetch must not retry-loop
  }
  const meta=[esc(id),esc(run.status),run.totalTokens!=null?fmt(run.totalTokens)+' tokens':'',run.durationMs!=null?dur(run.durationMs):'',run.agentCount!=null?fmt(run.agentCount)+' agents':''].filter(Boolean).join(' · ')
  setHtml('dtitle','<h2>'+esc(run.workflowName??'—')+' <span class="badge">('+esc(shortRun(id))+')</span></h2><div class="mut">'+meta+'</div>')
  setHtml('dbody',(run.error?'<div class="goal"><b>error</b>'+esc(run.error)+'</div>':'')+
    planHtml(id,run.description,run.phases,agentsCache.get(id)||[],0,false)+
    resultHtml(run))
  setHtml('dfoot',run.summary?'<div class="goal"><b>goal</b>'+esc(run.summary)+'</div>':'')
}
// pointerdown, not click: fires before any re-render can replace the target.
document.getElementById('rows').addEventListener('pointerdown',e=>{
  const tr=e.target.closest('tr');if(!tr)return
  if(tr.dataset.gk!==undefined){const k=tr.dataset.gk;collapsed.has(k)?collapsed.delete(k):collapsed.add(k);render();return}
  if(tr.classList.contains('sub')){
    if(!tr.dataset.agent)return
    // toggle: clicking the already-open agent closes the panel
    if(selTail&&selTail.runId===tr.dataset.run&&selTail.agentId===tr.dataset.agent)closeDrawer()
    else pickTail(tr.dataset.run,tr.dataset.agent)
    return
  }
  const id=tr.dataset.id
  if(!id||tr.dataset.nopick)return
  if(e.target.closest('.info')){sel===id?closeDrawer():pick(id);return}   // info icon toggles the run panel
  if(tr.classList.contains('lrun'))return           // live rows are always expanded
  expanded.has(id)?expanded.delete(id):(expanded.add(id),ensureAgents(id))
  render()                                          // row or caret click: toggle sub-rows only
})
document.getElementById('sf').addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return
  statusFilter=b.dataset.f
  for(const x of document.querySelectorAll('#sf button'))x.classList.toggle('on',x===b)
  render()
})
document.getElementById('hdr').addEventListener('click',e=>{
  const th=e.target.closest('th');if(!th||!th.dataset.k)return
  const k=th.dataset.k
  if(sortKey===k)sortDir=-sortDir
  else{sortKey=k;sortDir=(k==='timestamp'||NUM.has(k))?-1:1}
  render()
})
document.getElementById('filter').addEventListener('input',e=>{filter=e.target.value;render()})
document.getElementById('grp').addEventListener('change',e=>{groupOn=e.target.checked;render()})
document.getElementById('themec').addEventListener('click',()=>{
  themePref=themePref==='ide'?'light':themePref==='light'?'dark':'ide'
  localStorage.setItem('themePref',themePref);applyTheme()
})
const aiBtn=document.getElementById('aisum')
function aiLbl(){aiBtn.textContent='AI summaries: '+(aiOn?'on':'off')}
aiBtn.addEventListener('click',()=>{
  aiOn=!aiOn;localStorage.setItem('aiSum',aiOn?'on':'off');aiLbl()
  if(!aiOn)stopSumPolls()
  if(selTail)loadTail(selTail.runId,selTail.agentId)
  if(sel)loadDetail(sel)
})
aiLbl()
document.getElementById('close').addEventListener('click',closeDrawer)
addEventListener('keydown',e=>{if(e.key==='Escape')closeDrawer()})
const es=new EventSource('/events?t='+T)
es.onopen=()=>document.getElementById('dot').classList.add('live')
es.onerror=()=>document.getElementById('dot').classList.remove('live')
es.addEventListener('change',()=>{refresh();refreshLive()})
es.addEventListener('theme',()=>{if(themePref==='ide')applyTheme()})
es.addEventListener('tick',()=>{refresh();refreshLive(true)})
// fast poll while anything is live; 1s in-place tick keeps timers moving
setInterval(()=>{if(live&&Array.isArray(live.active)&&(live.active.length+(live.unattributed||[]).length))refreshLive()},5000)
setInterval(tickLive,1000)
refresh();refreshLive(true);applyTheme()
// deep-link: ?run=wf_x opens the run panel; &agent=<id> opens that agent's feed
{const P=new URLSearchParams(location.search),r=P.get('run'),a=P.get('agent')
 if(r&&a)setTimeout(()=>{expanded.add(r);ensureAgents(r);pickTail(r,a)},400)
 else if(r)setTimeout(()=>{expanded.add(r);ensureAgents(r);pick(r)},400)}
</script></body></html>`

// A concurrent instance may already hold the port: exit quietly WITHOUT
// touching the state file — the winner's state must stay authoritative.
server.on('error', () => process.exit(1))

server.listen(PORT, '127.0.0.1', async () => {
  // 0600/0700: the state file holds the bearer token; keep it out of reach of
  // other local users on shared hosts. Explicit chmod — writeFile's mode only
  // applies on creation, and both paths may pre-exist with looser modes.
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 })
  await fs.chmod(DATA_DIR, 0o700).catch(() => {})
  await loadSummaries()
  const stateFile = path.join(DATA_DIR, 'dashboard.json')
  await fs.writeFile(stateFile,
    JSON.stringify({ pid: process.pid, port: PORT, token: TOKEN, startedAt: new Date().toISOString(), version: VERSION }),
    { mode: 0o600 })
  await fs.chmod(stateFile, 0o600).catch(() => {})
  console.log(`conductor dashboard on http://127.0.0.1:${PORT}/?t=${TOKEN}`)
})
