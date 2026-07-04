#!/usr/bin/env node
// conductor dashboard — standalone localhost HTTP+SSE server, zero deps.
// Spawned detached by the MCP server's start_dashboard tool; may outlive it.
// Security: binds 127.0.0.1 only, bearer token on every route (transcripts
// can contain secrets), Origin/Host validated, idle self-shutdown.

import http from 'node:http'
import { promises as fs, watch } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { listRuns, getRun, getAgents, getLiveAgents, parseTranscriptTail, DEFAULT_PROJECTS_DIR } from './reader.js'

const PORT = Number(process.env.CONDUCTOR_PORT || 7423)
const TOKEN = process.env.CONDUCTOR_TOKEN
const DATA_DIR = process.env.CONDUCTOR_DATA_DIR || path.join(os.homedir(), '.claude', 'plugins', 'data', 'conductor-workflows-conductor')
const IDLE_LIMIT_MS = 30 * 60 * 1000
const HOOK_CLAIM_TTL_MS = 10 * 60 * 1000
const JUST_FINISHED_MS = 5 * 60 * 1000
const VERSION = '0.7.0'

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
    active.push({
      runId, source,
      name: hook?.name ?? null,
      lastActivity: cand?.lastActivity ?? null,
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
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE) }
    if (url.pathname === '/api/runs') {
      const runs = await listRuns({ scope: 'all', limit: Number(url.searchParams.get('limit') || 100) })
      const hookLive = await liveFromHookEvents({ recordedIds: new Set(runs.runs.map(r => r.runId)) })
      return json(res, { ...runs, hookLive })
    }
    if (url.pathname === '/api/live') return json(res, await liveState())
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
      return json(res, { runId, agentId, ...(await parseTranscriptTail(agent.transcriptPath)) })
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
tr.run{cursor:pointer}tr.run:hover{background:var(--card)}tr.sel{background:var(--card)}
tr.grp td{cursor:pointer;user-select:none;background:var(--card);color:var(--mut);font-size:12px;font-weight:600;max-width:none}
.s{padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line)}
.s.completed{color:var(--ok)}.s.killed,.s.unreadable{color:var(--bad)}.s.live{color:var(--ok);border-color:var(--ok)}.s.stale{color:var(--warn)}.s.unk{color:var(--warn)}
#detail{position:fixed;top:0;right:0;bottom:0;width:460px;max-width:100vw;background:var(--bg);border-left:1px solid var(--line);box-shadow:-6px 0 24px rgba(0,0,0,.18);overflow:auto;padding:16px 20px;z-index:20;display:none}
#detail.open{display:block}
#close{position:sticky;top:0;float:right;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;width:26px;height:26px;cursor:pointer;font:inherit;line-height:1;z-index:1}
#detail h2{font-size:14px;margin:0 0 4px}#detail .mut{color:var(--mut);font-size:12px}
.agent{padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin:8px 0;background:var(--card)}
.agent b{font-size:12px}.agent .mut{display:block;font-size:11px;word-break:break-all}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;white-space:pre-wrap;word-break:break-word;font-size:12px;max-height:280px;overflow:auto}
#live-wrap{padding:10px 20px;border-bottom:1px solid var(--line)}
.arun{border:1px solid var(--line);border-radius:10px;background:var(--card);padding:10px 12px;margin:8px 0}
.arun h3{margin:0 0 2px;font-size:13px}.arun .ph{font-size:11px;color:var(--mut);margin-bottom:6px}
.agrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px}
.acard{border:1px solid var(--line);border-radius:8px;background:var(--bg);padding:8px 10px;cursor:pointer}
.acard:hover{border-color:var(--acc)}
.acard b{font-size:12px}.acard .act{font-size:11px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.pdot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px;background:var(--mut)}
.pdot.on{background:var(--ok);animation:pulse 1.2s ease-in-out infinite}
.pdot.stall{background:var(--warn)}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.75)}}
.fin{display:inline-block;margin:2px 8px 2px 0;cursor:pointer}
.tev{border-left:2px solid var(--line);padding:2px 8px;margin:4px 0;font-size:12px}
.tev .tool{color:var(--acc)}.tev .badge{display:block}
.badge{font-size:11px;color:var(--mut)}
</style></head><body>
<header><h1>Workflows Conductor</h1><span id="totals"></span><input id="filter" type="search" placeholder="filter runs…" autocomplete="off"><label class="tog"><input type="checkbox" id="grp" checked>group by project</label><span id="dot" title="SSE"></span></header>
<div id="live-wrap"></div>
<main><section><table><thead><tr id="hdr"></tr></thead><tbody id="rows"></tbody></table></section></main>
<aside id="detail"><button id="close" title="close (Esc)">✕</button><div id="dbody"></div></aside>
<script>
const T=new URLSearchParams(location.search).get('t')
const q=p=>fetch(p+(p.includes('?')?'&':'?')+'t='+T).then(r=>r.json())
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const fmt=n=>n==null?'—':n.toLocaleString()
const dur=ms=>ms==null?'—':ms<60000?(ms/1000).toFixed(1)+'s':Math.round(ms/60000)+'m'
const when=ts=>ts?new Date(ts).toLocaleString():'—'
const shortProj=p=>{const s=String(p||'').split('-').filter(Boolean);return s.length?s.slice(-2).join('-'):'(no project)'}
// UI state lives here at module level; refresh() only swaps data and re-renders,
// so sort/filter/grouping/collapsed/selection all survive SSE-triggered refreshes.
let sel=null,sortKey='timestamp',sortDir=-1,filter='',groupOn=true,data=null
const collapsed=new Set()
const COLS=[['runId','run'],['workflowName','name'],['status','status'],['agentCount','agents'],['totalTokens','tokens'],['durationMs','dur'],['timestamp','when'],['projectDir','project']]
const NUM=new Set(['agentCount','totalTokens','durationMs'])
function cmp(a,b){
  let x=a[sortKey],y=b[sortKey]
  if(sortKey==='timestamp'){x=new Date(x??0).getTime()||0;y=new Date(y??0).getTime()||0;return (x-y)*sortDir}
  if(NUM.has(sortKey)){x=x==null?-Infinity:+x;y=y==null?-Infinity:+y;return (x-y)*sortDir}
  x=String(x??'').toLowerCase();y=String(y??'').toLowerCase()
  return (x<y?-1:x>y?1:0)*sortDir
}
function rowHtml(r){
  const cls=r.status==='completed'?'completed':(r.statusRecognized?'killed':'unk')
  const warn=r.compat!=='ok'?' <span class="badge">⚠ '+esc(r.compat)+'</span>':''
  return '<tr class="run'+(sel===r.runId?' sel':'')+'" data-id="'+esc(r.runId)+'"><td>'+esc(r.runId)+'</td><td>'+esc(r.workflowName??'—')+warn+'</td><td><span class="s '+cls+'">'+esc(r.status)+'</span></td><td>'+fmt(r.agentCount)+'</td><td>'+fmt(r.totalTokens)+'</td><td>'+dur(r.durationMs)+'</td><td>'+when(r.timestamp)+'</td><td class="badge">'+esc(r.projectDir??'')+'</td></tr>'
}
function render(){
  if(!data)return
  document.getElementById('hdr').innerHTML=COLS.map(c=>'<th data-k="'+c[0]+'">'+c[1]+(sortKey===c[0]?(sortDir>0?' ▲':' ▼'):'')+'</th>').join('')
  const nErr=(data.errors||[]).length
  document.getElementById('totals').textContent=data.totalRuns+' runs · '+data.projectCount+' projects'+(nErr?' · '+nErr+' unreadable':'')
  const f=filter.trim().toLowerCase()
  const runs=data.runs.filter(r=>!f||[r.runId,r.workflowName,r.status,r.projectDir].some(v=>String(v??'').toLowerCase().includes(f))).sort(cmp)
  let html=''
  if(groupOn){
    const groups=new Map()
    for(const r of runs){const k=r.projectDir??'';(groups.get(k)??groups.set(k,[]).get(k)).push(r)}
    for(const [k,rs] of groups){
      const open=!collapsed.has(k)
      html+='<tr class="grp" data-gk="'+esc(k)+'"><td colspan=8>'+(open?'▾ ':'▸ ')+esc(shortProj(k))+' <span class="badge">('+rs.length+' run'+(rs.length===1?'':'s')+')</span></td></tr>'
      if(open)html+=rs.map(rowHtml).join('')
    }
  }else html=runs.map(rowHtml).join('')
  document.getElementById('rows').innerHTML=html||'<tr><td colspan=8 class="badge">'+(data.runs.length?'No runs match the filter':'No workflow runs found — launch one with an ultracode: prompt (CLI ≥ 2.1.154)')+'</td></tr>'
}
// ── Active Runs (F2/F4): fed by /api/live, elapsed ticks locally between polls ──
let live=null,liveAt=0,selTail=null
const ago=ms=>{if(ms==null)return '—';const s=Math.max(0,Math.round(ms/1000));return s<60?s+'s':Math.floor(s/60)+'m '+(s%60)+'s'}
function actionText(a){
  if(!a)return 'no activity seen yet'
  if(a.kind==='tool')return a.tool+' '+(a.summary??'')
  return (a.snippet??'').slice(0,120)
}
// Agent badge label + dot class, shared by full render and in-place tick.
function agentBadge(a,drift){
  const running=a.state==='running'
  const unknown=a.state!=='running'&&a.state!=='done'
  const quiet=a.quietMs==null?null:a.quietMs+drift
  const stalled=running&&quiet!=null&&quiet>120000
  const fresh=running&&quiet!=null&&quiet<10000
  const elapsed=a.elapsedMs==null?null:a.elapsedMs+(running?drift:0)
  const label=unknown?'state unknown':(running?(stalled?'quiet '+ago(quiet)+' — stalled?':'running · '+ago(elapsed)):'done'+(a.elapsedMs?' · '+ago(a.elapsedMs):''))
  return {dot:stalled?'pdot stall':(fresh?'pdot on':'pdot'),label:label+(a.outputTokens?' · '+fmt(a.outputTokens)+' tok':'')}
}
function renderLive(){
  const el=document.getElementById('live-wrap')
  if(!live||!Array.isArray(live.active)){el.innerHTML='';return}
  const drift=Date.now()-liveAt
  let html=''
  for(const r of live.active){
    const phases=(r.phases||[]).map(p=>esc(p.title)).join(' → ')
    const cards=(r.agents||[]).map(a=>{
      const b=agentBadge(a,drift)
      return '<div class="acard" data-run="'+esc(r.runId)+'" data-agent="'+esc(a.agentId)+'">'+
        '<span class="'+b.dot+'"></span><b>'+esc(a.agentId.slice(0,10))+'</b> <span class="badge ab">'+esc(b.label)+'</span>'+
        '<div class="act">'+esc(actionText(a.currentAction))+'</div></div>'
    }).join('')
    html+='<div class="arun"><h3><span class="s live">'+esc(r.source)+'</span> '+esc(r.name??r.runId)+' <span class="badge">'+esc(r.runId)+'</span></h3>'+
      (phases?'<div class="ph">plan: '+phases+'</div>':'')+
      '<div class="agrid">'+(cards||'<span class="badge">no agents seen yet</span>')+'</div></div>'
  }
  for(const u of (live.unattributed||[])){
    html+='<div class="arun"><h3><span class="s live">running (hook)</span> '+esc(u.name??u.taskId)+' <span class="badge">run id not yet known</span></h3></div>'
  }
  const fins=(live.justFinished||[]).map(f=>'<span class="fin s '+(f.status==='completed'?'completed':'killed')+'" data-run="'+esc(f.runId)+'">✓ '+esc(f.workflowName??f.runId)+' · '+esc(f.status)+' <span class="fago" data-base="'+(f.finishedAgoMs??0)+'">'+ago(f.finishedAgoMs+drift)+'</span> ago · '+fmt(f.agentCount)+' agents · '+fmt(f.totalTokens)+' tok</span>').join('')
  el.innerHTML=(html?'<b class="badge">ACTIVE RUNS (live-state is heuristic until the CLI writes the terminal record)</b>'+html:'')+
    (fins?'<div>'+fins+'</div>':'')+
    (!html&&!fins?'<span class="badge">Nothing currently in flight</span>':'')
}
// 1s ticker: update timer text/dots IN PLACE. Never innerHTML — a DOM swap
// mid-click eats the click (this was the "clicking does nothing" bug), and
// swaps also restart the pulse animation every second.
function tickLive(){
  if(!live||!Array.isArray(live.active))return
  const drift=Date.now()-liveAt
  const byKey=new Map()
  for(const r of live.active)for(const a of (r.agents||[]))byKey.set(r.runId+'/'+a.agentId,a)
  for(const card of document.querySelectorAll('#live-wrap .acard')){
    const a=byKey.get(card.dataset.run+'/'+card.dataset.agent)
    if(!a)continue
    const b=agentBadge(a,drift)
    const badge=card.querySelector('.ab'),dot=card.querySelector('[class^="pdot"],.pdot')
    if(badge&&badge.textContent!==b.label)badge.textContent=b.label
    if(dot&&dot.className!==b.dot)dot.className=b.dot
  }
  for(const s of document.querySelectorAll('#live-wrap .fago'))s.textContent=ago(Number(s.dataset.base)+drift)
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
    renderLive()
    if(selTail)loadTail(selTail.runId,selTail.agentId)
  }catch{}finally{liveBusy=false}
}
async function loadTail(runId,agentId){
  const t=await q('/api/tail/'+encodeURIComponent(runId)+'/'+encodeURIComponent(agentId))
  if(!selTail||selTail.runId!==runId||selTail.agentId!==agentId)return
  const evs=(t.events||[]).map(e=>{
    if(e.kind==='tool')return '<div class="tev"><span class="tool">'+esc(e.tool)+'</span> <span class="badge">'+esc(e.summary??'')+'</span></div>'
    if(e.kind==='text')return '<div class="tev">'+esc(e.snippet??'')+'</div>'
    return '<div class="tev badge">↳ tool result</div>'
  }).join('')
  const d=document.getElementById('detail')
  const nearBottom=d.scrollHeight-d.scrollTop-d.clientHeight<80
  document.getElementById('dbody').innerHTML='<h2>agent '+esc(agentId.slice(0,10))+'…</h2><div class="mut">'+esc(runId)+
    (t.outputTokens?' · '+fmt(t.outputTokens)+' output tok (window)':'')+'</div>'+
    (evs||'<span class="badge">no parsed events in the tail window yet</span>')
  const wasOpen=d.classList.contains('open')
  d.classList.add('open')
  if(!wasOpen||nearBottom)d.scrollTop=d.scrollHeight   // autoscroll only when following the tail
}
async function refresh(){
  data=await q('/api/runs')
  render()
  if(sel)loadDetail(sel)
}
function pick(id){selTail=null;sel=id;render();document.getElementById('detail').classList.add('open');loadDetail(id)}
function pickTail(runId,agentId){
  sel=null;selTail={runId,agentId};render()
  // instant feedback: open with a placeholder before the fetch resolves
  document.getElementById('dbody').innerHTML='<span class="badge">loading agent feed…</span>'
  document.getElementById('detail').classList.add('open')
  loadTail(runId,agentId)
}
function closeDrawer(){if(sel==null&&selTail==null)return;sel=null;selTail=null;document.getElementById('detail').classList.remove('open');render()}
async function loadDetail(id){
  const [run,ag]=await Promise.all([q('/api/run/'+encodeURIComponent(id)),q('/api/agents/'+encodeURIComponent(id))])
  if(sel!==id)return
  const agents=(ag.agents||[]).map(a=>'<div class="agent"><b>'+esc(a.label??a.agentId)+'</b> <span class="badge">'+esc(a.state??(a.finished?'done':a.started?'started':'?'))+(a.tokens?' · '+fmt(a.tokens)+' tok':'')+'</span>'+(a.transcriptPath?'<span class="mut">'+esc(a.transcriptPath)+'</span>':'')+'</div>').join('')
  document.getElementById('dbody').innerHTML='<h2>'+esc(run.workflowName??id)+'</h2><div class="mut">'+esc(id)+' · '+esc(run.status)+' · '+fmt(run.totalTokens)+' tokens · '+dur(run.durationMs)+(run.error?'<br>error: '+esc(run.error):'')+'</div>'+
    (run.summary?'<p>'+esc(run.summary)+'</p>':'')+(run.resultPreview?'<pre>'+esc(run.resultPreview)+(run.resultTruncated?'\\n… (truncated)':'')+'</pre>':'')+
    '<h2>Agents ('+(ag.agents||[]).length+')</h2>'+agents
}
document.getElementById('rows').addEventListener('click',e=>{
  const tr=e.target.closest('tr');if(!tr)return
  if(tr.dataset.gk!==undefined){const k=tr.dataset.gk;collapsed.has(k)?collapsed.delete(k):collapsed.add(k);render();return}
  if(tr.dataset.id)pick(tr.dataset.id)
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
document.getElementById('close').addEventListener('click',closeDrawer)
addEventListener('keydown',e=>{if(e.key==='Escape')closeDrawer()})
// pointerdown, not click: it fires before any DOM update can replace the
// target, so interactions can't be lost to a re-render.
document.getElementById('live-wrap').addEventListener('pointerdown',e=>{
  const card=e.target.closest('.acard')
  if(card)return pickTail(card.dataset.run,card.dataset.agent)
  const fin=e.target.closest('.fin')
  if(fin)pick(fin.dataset.run)
})
const es=new EventSource('/events?t='+T)
es.onopen=()=>document.getElementById('dot').classList.add('live')
es.onerror=()=>document.getElementById('dot').classList.remove('live')
es.addEventListener('change',()=>{refresh();refreshLive()})
es.addEventListener('tick',()=>{refresh();refreshLive(true)})
// fast poll while anything is active or in the grace window; 1s in-place tick keeps timers moving
setInterval(()=>{if(live&&Array.isArray(live.active)&&(live.active.length+(live.justFinished||[]).length+(live.unattributed||[]).length))refreshLive()},5000)
setInterval(tickLive,1000)
refresh();refreshLive(true)
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
  const stateFile = path.join(DATA_DIR, 'dashboard.json')
  await fs.writeFile(stateFile,
    JSON.stringify({ pid: process.pid, port: PORT, token: TOKEN, startedAt: new Date().toISOString(), version: VERSION }),
    { mode: 0o600 })
  await fs.chmod(stateFile, 0o600).catch(() => {})
  console.log(`conductor dashboard on http://127.0.0.1:${PORT}/?t=${TOKEN}`)
})
