#!/usr/bin/env node
// conductor dashboard — standalone localhost HTTP+SSE server, zero deps.
// Spawned detached by the MCP server's start_dashboard tool; may outlive it.
// Security: binds 127.0.0.1 only, bearer token on every route (transcripts
// can contain secrets), Origin/Host validated, idle self-shutdown.

import http from 'node:http'
import { promises as fs, watch } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { listRuns, getRun, getAgents, DEFAULT_PROJECTS_DIR } from './reader.js'

const PORT = Number(process.env.CONDUCTOR_PORT || 7423)
const TOKEN = process.env.CONDUCTOR_TOKEN
const DATA_DIR = process.env.CONDUCTOR_DATA_DIR || path.join(os.homedir(), '.claude', 'plugins', 'data', 'conductor-workflows-conductor')
const IDLE_LIMIT_MS = 30 * 60 * 1000
const VERSION = '0.6.0'

if (!TOKEN) { console.error('CONDUCTOR_TOKEN required'); process.exit(2) }

let lastActivity = Date.now()
const sseClients = new Set()

// ── live status from hook events (spike 4): latest background_tasks entries ──
async function liveFromHookEvents() {
  const out = new Map()
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, 'events.jsonl'), 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let ev; try { ev = JSON.parse(line) } catch { continue }
      const runId = ev.agent_transcript_path?.match(/\/workflows\/(wf_[^/]+)\//)?.[1] ?? null
      for (const t of ev.background_tasks ?? []) {
        if (t.type === 'workflow') out.set(t.id, { taskId: t.id, name: t.name, status: t.status, runId, seenAt: ev.conductor_logged_at ?? null })
      }
    }
  } catch { /* no events yet */ }
  return [...out.values()]
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
  lastActivity = Date.now()
  if (url.pathname === '/health') return json(res, { ok: authorized(req, url), name: 'conductor-dashboard', version: VERSION, pid: process.pid })
  if (!authorized(req, url)) return json(res, { error: 'unauthorized' }, 401)

  try {
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE) }
    if (url.pathname === '/api/runs') {
      const [runs, hookLive] = await Promise.all([
        listRuns({ scope: 'all', limit: Number(url.searchParams.get('limit') || 100) }),
        liveFromHookEvents(),
      ])
      return json(res, { ...runs, hookLive })
    }
    if (url.pathname.startsWith('/api/run/')) return json(res, await getRun(url.pathname.split('/')[3]))
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
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e5e7eb;--mut:#9ca3af;--line:#252a33;--card:#171b22;--acc:#818cf8;--ok:#34d399;--bad:#f87171;--warn:#fbbf24}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 ui-sans-serif,system-ui;background:var(--bg);color:var(--fg)}
header{display:flex;gap:16px;align-items:baseline;padding:16px 20px;border-bottom:1px solid var(--line)}
h1{font-size:16px;margin:0}#totals{color:var(--mut)}#dot{width:8px;height:8px;border-radius:50%;background:var(--mut);display:inline-block;margin-left:auto}
#dot.live{background:var(--ok)}
main{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,420px);gap:0}
@media(max-width:900px){main{grid-template-columns:1fr}}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
th{color:var(--mut);font-weight:500;font-size:12px;position:sticky;top:0;background:var(--bg)}
tr.run{cursor:pointer}tr.run:hover{background:var(--card)}tr.sel{background:var(--card)}
.s{padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line)}
.s.completed{color:var(--ok)}.s.killed,.s.unreadable{color:var(--bad)}.s.live{color:var(--ok);border-color:var(--ok)}.s.stale{color:var(--warn)}.s.unk{color:var(--warn)}
#detail{border-left:1px solid var(--line);padding:16px 20px;min-height:calc(100vh - 60px)}
#detail h2{font-size:14px;margin:0 0 4px}#detail .mut{color:var(--mut);font-size:12px}
.agent{padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin:8px 0;background:var(--card)}
.agent b{font-size:12px}.agent .mut{display:block;font-size:11px;word-break:break-all}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;white-space:pre-wrap;word-break:break-word;font-size:12px;max-height:280px;overflow:auto}
section{padding:0 0 8px}#live-wrap{padding:10px 20px;border-bottom:1px solid var(--line)}#live-wrap:empty{display:none}
.badge{font-size:11px;color:var(--mut)}
</style></head><body>
<header><h1>Workflows Conductor</h1><span id="totals"></span><span id="dot" title="SSE"></span></header>
<div id="live-wrap"></div>
<main><section><table><thead><tr><th>run</th><th>name</th><th>status</th><th>agents</th><th>tokens</th><th>dur</th><th>when</th><th>project</th></tr></thead><tbody id="rows"></tbody></table></section>
<aside id="detail"><span class="mut">Select a run</span></aside></main>
<script>
const T=new URLSearchParams(location.search).get('t')
const q=p=>fetch(p+(p.includes('?')?'&':'?')+'t='+T).then(r=>r.json())
const fmt=n=>n==null?'—':n.toLocaleString()
const dur=ms=>ms==null?'—':ms<60000?(ms/1000).toFixed(1)+'s':Math.round(ms/60000)+'m'
const when=ts=>ts?new Date(ts).toLocaleString():'—'
let sel=null
async function refresh(){
  const d=await q('/api/runs')
  document.getElementById('totals').textContent=d.totalRuns+' runs · '+d.projectCount+' projects'+(d.readErrors?' · '+d.readErrors+' unreadable':'')
  const rows=d.runs.map(r=>{
    const cls=r.status==='completed'?'completed':(r.statusRecognized?'killed':'unk')
    const warn=r.compat!=='ok'?' <span class="badge">⚠ '+r.compat+'</span>':''
    return '<tr class="run'+(sel===r.runId?' sel':'')+'" onclick="pick(\\''+r.runId+'\\')"><td>'+r.runId+'</td><td>'+(r.workflowName??'—')+warn+'</td><td><span class="s '+cls+'">'+r.status+'</span></td><td>'+fmt(r.agentCount)+'</td><td>'+fmt(r.totalTokens)+'</td><td>'+dur(r.durationMs)+'</td><td>'+when(r.timestamp)+'</td><td class="badge">'+(r.projectDir??'')+'</td></tr>'
  }).join('')
  document.getElementById('rows').innerHTML=rows||'<tr><td colspan=8 class="badge">No workflow runs found — launch one with an ultracode: prompt (CLI ≥ 2.1.154)</td></tr>'
  const live=[...d.liveCandidates.map(c=>'<span class="s '+(c.derivedStatus==='live?'?'live':'stale')+'">'+c.runId+' · '+c.derivedStatus+' · last activity '+when(c.lastActivity)+'</span>'),
              ...d.hookLive.filter(h=>h.status==='running').map(h=>'<span class="s live">'+(h.runId??h.taskId)+' · running (hook) · '+(h.name??'')+'</span>')]
  document.getElementById('live-wrap').innerHTML=live.length?'<b class="badge">LIVE / IN-FLIGHT (heuristic)</b> '+live.join(' '):''
}
async function pick(id){
  sel=id;refresh()
  const [run,ag]=await Promise.all([q('/api/run/'+id),q('/api/agents/'+id)])
  const agents=(ag.agents||[]).map(a=>'<div class="agent"><b>'+(a.label??a.agentId)+'</b> <span class="badge">'+(a.state??(a.finished?'done':a.started?'started':'?'))+(a.tokens?' · '+fmt(a.tokens)+' tok':'')+'</span>'+(a.transcriptPath?'<span class="mut">'+a.transcriptPath+'</span>':'')+'</div>').join('')
  document.getElementById('detail').innerHTML='<h2>'+(run.workflowName??id)+'</h2><div class="mut">'+id+' · '+run.status+' · '+fmt(run.totalTokens)+' tokens · '+dur(run.durationMs)+(run.error?'<br>error: '+run.error:'')+'</div>'+
    (run.summary?'<p>'+run.summary+'</p>':'')+(run.resultPreview?'<pre>'+run.resultPreview.replace(/</g,'&lt;')+(run.resultTruncated?'\\n… (truncated)':'')+'</pre>':'')+
    '<h2>Agents ('+(ag.agents||[]).length+')</h2>'+agents
}
const es=new EventSource('/events?t='+T)
es.onopen=()=>document.getElementById('dot').classList.add('live')
es.onerror=()=>document.getElementById('dot').classList.remove('live')
es.addEventListener('change',refresh);es.addEventListener('tick',refresh)
refresh()
</script></body></html>`

// A concurrent instance may already hold the port: exit quietly WITHOUT
// touching the state file — the winner's state must stay authoritative.
server.on('error', () => process.exit(1))

server.listen(PORT, '127.0.0.1', async () => {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(path.join(DATA_DIR, 'dashboard.json'),
    JSON.stringify({ pid: process.pid, port: PORT, token: TOKEN, startedAt: new Date().toISOString(), version: VERSION }))
  console.log(`conductor dashboard on http://127.0.0.1:${PORT}/?t=${TOKEN}`)
})
