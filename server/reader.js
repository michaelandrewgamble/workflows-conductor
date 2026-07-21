// reader.js — workflow run state reader for Claude Code dynamic workflows.
//
// The wf_*.json / journal.jsonl formats are UNDOCUMENTED and observed to vary
// across CLI versions on a single machine. Every parse in this file must
// degrade per-record, never throw past its boundary, and pass unknown values
// through verbatim. See ARCHITECTURE.md §2.5.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')
export const CLEANUP_PERIOD_DAYS = 30
const LIVE_WINDOW_MS = 10 * 60 * 1000
// Fields a record must have to be 'ok'; a subset present → 'degraded'.
const EXPECTED_FIELDS = ['runId', 'workflowName', 'status', 'agentCount', 'totalTokens', 'durationMs', 'timestamp']
const TERMINAL_STATUSES = new Set(['completed', 'killed', 'failed', 'errored', 'error'])

// cwd → the encoded directory name used under ~/.claude/projects.
// Forward-encode only; encoded names cannot be safely decoded back.
export function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

// Display hygiene: never show the user's home path (and thus their OS
// username) in goals, tool summaries, or snippets — ~ reads better anyway.
const HOME = os.homedir()
function tidy(s) { return typeof s === 'string' ? s.split(HOME).join('~') : s }
// runId/agentId → matched author label; labels are immutable, cache forever.
const labelMatchCache = new Map()

async function safeReaddir(dir) {
  try { return await fs.readdir(dir, { withFileTypes: true }) } catch { return [] }
}

async function safeStat(p) {
  try { return await fs.stat(p) } catch { return null }
}

// JSON.parse with one delayed retry: run records may be mid-write when read.
async function parseJsonFile(file, { retryMs = 100 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let raw
    try { raw = await fs.readFile(file, 'utf8') } catch (err) {
      return { ok: false, error: `unreadable: ${err.code || err.message}` }
    }
    try { return { ok: true, value: JSON.parse(raw) } } catch (err) {
      if (attempt === 0) { await new Promise(r => setTimeout(r, retryMs)); continue }
      return { ok: false, error: `parse-failed: ${err.message}` }
    }
  }
}

// JSONL where the final line may be a torn (in-progress) write: drop it silently.
async function parseJsonl(file) {
  let raw
  try { raw = await fs.readFile(file, 'utf8') } catch { return { records: [], dropped: 0 } }
  const records = []
  let dropped = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { records.push(JSON.parse(line)) } catch { dropped++ }
  }
  return { records, dropped }
}

function compatOf(record) {
  if (typeof record !== 'object' || record === null) return 'unknown-format'
  const present = EXPECTED_FIELDS.filter(f => record[f] !== undefined)
  if (present.length === EXPECTED_FIELDS.length) return 'ok'
  if (record.runId !== undefined || record.status !== undefined) return 'degraded'
  return 'unknown-format'
}

function runIdFromFilename(file) {
  const m = path.basename(file).match(/^(wf_[^.]+)\.json$/)
  return m ? m[1] : null
}

function toRow(record, recordPath, now) {
  const timestamp = record.timestamp ?? null
  const ageMs = timestamp ? now - Date.parse(timestamp) : null
  const ageDays = ageMs !== null && !Number.isNaN(ageMs) ? ageMs / 86400000 : null
  return {
    runId: record.runId ?? runIdFromFilename(recordPath) ?? '?',
    workflowName: record.workflowName ?? null,
    status: record.status ?? 'unknown',          // raw passthrough — open enum
    isTerminal: TERMINAL_STATUSES.has(record.status),
    statusRecognized: TERMINAL_STATUSES.has(record.status),
    compat: compatOf(record),
    summary: record.summary ?? null,
    agentCount: record.agentCount ?? null,
    totalTokens: record.totalTokens ?? null,
    totalToolCalls: record.totalToolCalls ?? null,
    durationMs: record.durationMs ?? null,
    startTime: record.startTime ?? null,
    timestamp,
    ageDays,
    expiresInDays: ageDays !== null ? Math.max(0, CLEANUP_PERIOD_DAYS - ageDays) : null,
    error: record.error ?? null,
    defaultModel: record.defaultModel ?? null,
    hasInlineScript: typeof record.script === 'string' && record.script.length > 0,
    scriptPath: record.scriptPath ?? null,
    recordPath,
    projectDir: projectDirOf(recordPath),
    sessionId: sessionIdOf(recordPath),
  }
}

function projectDirOf(p) {
  const parts = p.split(path.sep)
  const i = parts.lastIndexOf('projects')
  return i >= 0 && parts[i + 1] ? parts[i + 1] : null
}

function sessionIdOf(p) {
  const parts = p.split(path.sep)
  const i = parts.lastIndexOf('projects')
  return i >= 0 && parts[i + 2] ? parts[i + 2] : null
}

// A run belongs to `cwd` if its record lives under the encoded cwd, or its
// scriptPath points under the real cwd or the encoded cwd (records and
// scripts can be split across project dirs sharing a session UUID).
function belongsTo(row, cwd, encoded) {
  if (row.projectDir === encoded) return true
  const sp = row.scriptPath
  if (!sp) return false
  return sp.startsWith(cwd + path.sep) || sp.includes(`${path.sep}projects${path.sep}${encoded}${path.sep}`)
}

async function findRunRecordFiles(projectsDir) {
  const files = []
  for (const proj of await safeReaddir(projectsDir)) {
    if (!proj.isDirectory()) continue
    const projPath = path.join(projectsDir, proj.name)
    for (const session of await safeReaddir(projPath)) {
      if (!session.isDirectory()) continue
      const wfDir = path.join(projPath, session.name, 'workflows')
      for (const f of await safeReaddir(wfDir)) {
        if (f.isFile() && /^wf_.*\.json$/.test(f.name)) files.push(path.join(wfDir, f.name))
      }
    }
  }
  return files
}

async function findRunAgentDirs(projectsDir) {
  const dirs = []
  for (const proj of await safeReaddir(projectsDir)) {
    if (!proj.isDirectory()) continue
    const projPath = path.join(projectsDir, proj.name)
    for (const session of await safeReaddir(projPath)) {
      if (!session.isDirectory()) continue
      const base = path.join(projPath, session.name, 'subagents', 'workflows')
      for (const d of await safeReaddir(base)) {
        if (d.isDirectory() && d.name.startsWith('wf_')) dirs.push(path.join(base, d.name))
      }
    }
  }
  return dirs
}

async function maxMtime(dir) {
  let max = 0
  for (const entry of await safeReaddir(dir)) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) { max = Math.max(max, await maxMtime(p)); continue }
    const st = await safeStat(p)
    if (st) max = Math.max(max, st.mtimeMs)
  }
  return max
}

export async function listRuns({
  projectsDir = DEFAULT_PROJECTS_DIR,
  cwd = process.cwd(),
  scope = 'project',            // 'project' | 'all'
  limit = 10,
  now = Date.now(),
} = {}) {
  const encoded = encodeCwd(cwd)
  const files = await findRunRecordFiles(projectsDir)
  const rows = []
  const errors = []

  for (const file of files) {
    const parsed = await parseJsonFile(file)
    if (!parsed.ok) {
      rows.push({
        runId: runIdFromFilename(file) ?? '?', workflowName: null, status: 'unreadable',
        isTerminal: false, statusRecognized: false, compat: 'unreadable',
        recordPath: file, projectDir: projectDirOf(file), sessionId: sessionIdOf(file),
        scriptPath: null, timestamp: null, ageDays: null, expiresInDays: null,
        error: parsed.error, hasInlineScript: false,
      })
      errors.push({ file, error: parsed.error })
      continue
    }
    rows.push(toRow(parsed.value, file, now))
  }

  // Live/interrupted candidates: run agent dirs with no record anywhere —
  // PLUS recorded runs whose dir has activity NEWER than the record. A killed
  // run resumed in its owning session reuses the same runId/dir, and the old
  // terminal record lingers until the resume reaches its own terminal state.
  const recordedRows = new Map(rows.map(r => [r.runId, r]))
  const liveCandidates = []
  for (const dir of await findRunAgentDirs(projectsDir)) {
    const runId = path.basename(dir)
    const rec = recordedRows.get(runId)
    const last = await maxMtime(dir)
    if (rec) {
      const recordedAt = Date.parse(rec.timestamp ?? 0) || 0
      if (!last || last <= recordedAt + 5000) continue      // record is current
      liveCandidates.push({
        runId,
        projectDir: projectDirOf(dir),
        sessionId: sessionIdOf(dir),
        lastActivity: new Date(last).toISOString(),
        derivedStatus: now - last < LIVE_WINDOW_MS ? 'live?' : 'stale',
        resumedAfter: rec.status,                            // e.g. 'killed'
        agentDir: dir,
      })
      continue
    }
    liveCandidates.push({
      runId,
      projectDir: projectDirOf(dir),
      sessionId: sessionIdOf(dir),
      lastActivity: last ? new Date(last).toISOString() : null,
      // Heuristic only: the CLI writes records at terminal state, so absence
      // of a record + recent writes ≈ live; absence + silence ≈ interrupted.
      derivedStatus: last && now - last < LIVE_WINDOW_MS ? 'live?' : 'stale',
      agentDir: dir,
    })
  }

  const scoped = scope === 'all' ? rows : rows.filter(r => belongsTo(r, cwd, encoded))
  scoped.sort((a, b) => (Date.parse(b.timestamp ?? 0) || 0) - (Date.parse(a.timestamp ?? 0) || 0))
  const scopedLive = scope === 'all' ? liveCandidates : liveCandidates.filter(c => c.projectDir === encoded)

  return {
    runs: scoped.slice(0, limit),
    omitted: Math.max(0, scoped.length - limit),
    totalRuns: rows.length,
    projectCount: new Set(rows.map(r => r.projectDir)).size,
    liveCandidates: scopedLive,
    errors,
    scope, cwd, encodedCwd: encoded,
  }
}

async function findRecordFor(runId, projectsDir) {
  for (const file of await findRunRecordFiles(projectsDir)) {
    if (runIdFromFilename(file) === runId) return file
  }
  return null
}

const SECTION_CAP = 4000

// Readable projection of a record's result for panel rendering: one section
// per top-level key (string values pass through, everything else is
// pretty-stringified), each tidy()-redacted and capped. [] on anything weird.
function resultSectionsOf(result) {
  try {
    const section = (key, value) => {
      let text
      if (typeof value === 'string') text = value
      else {
        try { text = JSON.stringify(value, null, 1) } catch { text = String(value) }
        if (typeof text !== 'string') text = String(value)   // stringify(undefined) etc.
      }
      text = tidy(text)
      const truncated = text.length > SECTION_CAP
      return { key, text: truncated ? text.slice(0, SECTION_CAP) : text, truncated }
    }
    if (typeof result === 'string') return [section(null, result)]
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      return Object.keys(result).map(k => section(k, result[k]))
    }
    return []                                                // missing or non-plain: nothing to render
  } catch { return [] }
}

export async function getRun(runId, { projectsDir = DEFAULT_PROJECTS_DIR, now = Date.now() } = {}) {
  const file = await findRecordFor(runId, projectsDir)
  if (!file) return { found: false, runId, reason: 'no run record on disk (expired, never finished, or wrong id)' }
  const parsed = await parseJsonFile(file)
  if (!parsed.ok) return { found: false, runId, reason: parsed.error, recordPath: file }
  const row = toRow(parsed.value, file, now)
  // Projection: metadata only. Script via getScript, full result elided by size.
  const result = parsed.value.result
  const resultStr = result === undefined ? null : (typeof result === 'string' ? result : JSON.stringify(result))
  return {
    found: true, ...row,
    phases: parsed.value.phases ?? null,
    resultPreview: resultStr === null ? null : resultStr.slice(0, 2000),
    resultTruncated: resultStr !== null && resultStr.length > 2000,
    resultSections: resultSectionsOf(result),
  }
}

export async function getAgents(runId, { projectsDir = DEFAULT_PROJECTS_DIR } = {}) {
  const agents = new Map()
  const note = []

  // Preferred source: workflow_agent entries inside the run record (present in
  // some CLI versions' records, absent in others).
  const file = await findRecordFor(runId, projectsDir)
  if (file) {
    const parsed = await parseJsonFile(file)
    if (parsed.ok && Array.isArray(parsed.value.workflowProgress)) {
      for (const e of parsed.value.workflowProgress) {
        if (e && e.type === 'workflow_agent' && e.agentId) {
          agents.set(e.agentId, {
            agentId: e.agentId, label: e.label ?? null, state: e.state ?? null,
            phaseTitle: e.phaseTitle ?? null, model: e.model ?? null,
            tokens: e.tokens ?? null, toolCalls: e.toolCalls ?? null,
            durationMs: e.durationMs ?? null, resultPreview: e.resultPreview ?? null,
            promptPreview: e.promptPreview ?? null,
            title: deriveTitle(e.label ?? null, e.promptPreview ?? null),
            source: 'record',
          })
        }
      }
      if (agents.size) note.push('per-agent data from run record workflowProgress')
    }
  }

  // Fallback/augment: journal started/result pairing + transcript paths.
  for (const dir of await findRunAgentDirs(projectsDir)) {
    if (path.basename(dir) !== runId) continue
    const { records, dropped } = await parseJsonl(path.join(dir, 'journal.jsonl'))
    if (dropped) note.push(`journal: dropped ${dropped} torn/unparseable line(s)`)
    for (const rec of records) {
      if (!rec.agentId) continue
      const a = agents.get(rec.agentId) ?? { agentId: rec.agentId, source: 'journal' }
      if (rec.type === 'started') a.started = true
      if (rec.type === 'result') a.finished = true
      agents.set(rec.agentId, a)
    }
    for (const f of await safeReaddir(dir)) {
      const m = f.name.match(/^agent-(.+)\.jsonl$/)
      if (!m) continue
      const a = agents.get(m[1]) ?? { agentId: m[1], source: 'transcript' }
      a.transcriptPath = path.join(dir, f.name)   // path only — never inlined
      agents.set(m[1], a)
    }
  }

  return { runId, agents: [...agents.values()], notes: note }
}

export async function getScript(runId, { projectsDir = DEFAULT_PROJECTS_DIR } = {}) {
  const file = await findRecordFor(runId, projectsDir)
  if (file) {
    const parsed = await parseJsonFile(file)
    if (parsed.ok && typeof parsed.value.script === 'string' && parsed.value.script) {
      return { found: true, source: 'inline', script: parsed.value.script, scriptPath: parsed.value.scriptPath ?? null }
    }
    if (parsed.ok && parsed.value.scriptPath) {
      try {
        return { found: true, source: 'scriptPath', script: await fs.readFile(parsed.value.scriptPath, 'utf8'), scriptPath: parsed.value.scriptPath }
      } catch { /* fall through to scripts/ copies */ }
    }
  }
  // Last resort: a script copy named <workflowName>-<runId>.js in any scripts/ dir.
  for (const rec of await findRunRecordFiles(projectsDir)) void rec // records already checked
  for (const proj of await safeReaddir(projectsDir)) {
    if (!proj.isDirectory()) continue
    for (const session of await safeReaddir(path.join(projectsDir, proj.name))) {
      if (!session.isDirectory()) continue
      const scriptsDir = path.join(projectsDir, proj.name, session.name, 'workflows', 'scripts')
      for (const f of await safeReaddir(scriptsDir)) {
        if (f.isFile() && f.name.includes(runId)) {
          const p = path.join(scriptsDir, f.name)
          try { return { found: true, source: 'scripts-copy', script: await fs.readFile(p, 'utf8'), scriptPath: p } } catch { /* keep looking */ }
        }
      }
    }
  }
  return { found: false, runId, reason: 'no inline script, scriptPath unreadable, no scripts/ copy' }
}

// ---------------------------------------------------------------------------
// Live-agent observability (0.7 / F2). Same rules as everything above: the
// transcript and hook-event schemas are undocumented and observed to vary —
// degrade per-record, never throw past the function boundary.
// ---------------------------------------------------------------------------

const FRESH_WINDOW_MS = 10 * 1000

// Tail-read a (possibly large, possibly growing) per-agent transcript and
// reduce it to a live view: recent events, token burn, current action.
// Reads at most the last maxBytes; drops the leading partial line when the
// window starts mid-file and any torn (in-progress) trailing line.
export async function parseTranscriptTail(filePath, { maxBytes = 65536, maxEvents = 30 } = {}) {
  const out = { events: [], firstTimestamp: null, lastTimestamp: null, outputTokens: null, currentAction: null, model: null, stats: { events: 0, toolCounts: {} } }
  let text = null
  let startedMidFile = false
  let fh = null
  try {
    fh = await fs.open(filePath, 'r')
    const st = await fh.stat()
    // Read one extra byte before the window: if it's '\n', the window starts
    // exactly at a line boundary and the first segment is COMPLETE — keep it.
    const offset = Math.max(0, st.size - maxBytes - 1)
    startedMidFile = offset > 0 || st.size > maxBytes
    const len = st.size - offset
    if (len <= 0) return out
    const buf = Buffer.alloc(len)
    const { bytesRead } = await fh.read(buf, 0, len, offset)
    text = buf.subarray(0, bytesRead).toString('utf8')
  } catch {
    return out
  } finally {
    if (fh) await fh.close().catch(() => {})
  }

  const segments = text.split('\n')
  // With the extra byte, segments[0] is either '' (window began at a line
  // boundary) or a genuine partial line — dropping it is correct either way.
  if (startedMidFile) segments.shift()
  const events = []
  let tokens = null
  for (const seg of segments) {
    if (!seg.trim()) continue
    let line
    try { line = JSON.parse(seg) } catch { continue }      // torn/garbage line
    if (typeof line !== 'object' || line === null) continue
    const at = typeof line.timestamp === 'string' ? line.timestamp : null
    if (at) {
      if (!out.firstTimestamp) out.firstTimestamp = at     // earliest SEEN in window, not true start
      out.lastTimestamp = at
    }
    if (line.type === 'assistant' && Array.isArray(line.message?.content)) {
      const ot = line.message?.usage?.output_tokens
      if (typeof ot === 'number') tokens = (tokens ?? 0) + ot
      if (typeof line.message?.model === 'string') out.model = line.message.model   // last seen wins
      for (const block of line.message.content) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'tool_use') {
          let summary
          try { summary = JSON.stringify(block.input ?? null) ?? 'null' } catch { summary = String(block.input) }
          events.push({ kind: 'tool', at, tool: block.name ?? null, summary: tidy(summary.slice(0, 160)) })
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          events.push({ kind: 'text', at, snippet: tidy(block.text.slice(0, 200)) })
        }
      }
    } else if (line.type === 'user' && Array.isArray(line.message?.content) &&
               line.message.content.some(b => b && b.type === 'tool_result')) {
      events.push({ kind: 'tool-result', at })             // no content: results can be huge/secret
    }
  }
  out.outputTokens = tokens
  // Window-wide stats: every parsed event counts, not just the maxEvents kept.
  const toolCounts = {}
  for (const e of events) {
    if (e.kind !== 'tool' || typeof e.tool !== 'string') continue
    toolCounts[e.tool] = (Object.hasOwn(toolCounts, e.tool) ? toolCounts[e.tool] : 0) + 1
  }
  out.stats = { events: events.length, toolCounts }
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === 'tool' || events[i].kind === 'text') { out.currentAction = events[i]; break }
  }
  out.events = events.slice(-maxEvents)
  return out
}

// String-aware balanced-delimiter scan: returns the source between openIdx's
// delimiter and its match (exclusive), or null when unbalanced.
function scanBalanced(src, openIdx, open, close) {
  let depth = 0
  let quote = null
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return src.slice(openIdx + 1, i)
    }
  }
  return null
}

function stringProp(objSrc, key) {
  const m = objSrc.match(new RegExp(`(?:^|[,{\\s])${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`))
  return m ? m[2].replace(/\\(['"`\\])/g, '$1') : null
}

// Extract meta.phases ({title, detail?}[]) from a workflow script's
// `export const meta = {...}` WITHOUT executing it. Tolerant: [] on anything
// absent or unparseable.
export function parsePhases(scriptSource) {
  try {
    if (typeof scriptSource !== 'string') return []
    const metaStart = scriptSource.search(/export\s+const\s+meta\s*=\s*\{/)
    if (metaStart < 0) return []
    const metaBody = scanBalanced(scriptSource, scriptSource.indexOf('{', metaStart), '{', '}')
    if (metaBody === null) return []
    const pm = metaBody.match(/phases\s*:\s*\[/)
    if (!pm) return []
    const arrBody = scanBalanced(metaBody, metaBody.indexOf('[', pm.index), '[', ']')
    if (arrBody === null) return []
    const phases = []
    for (let i = 0; i < arrBody.length; i++) {
      if (arrBody[i] !== '{') continue
      const obj = scanBalanced(arrBody, i, '{', '}')
      if (obj === null) break
      i += obj.length + 1
      const title = stringProp(obj, 'title')
      if (title === null) continue                         // phase without a title: skip, don't fail
      const detail = stringProp(obj, 'detail')
      phases.push(detail !== null ? { title, detail } : { title })
    }
    return phases
  } catch { return [] }
}

// Extract meta.description from a workflow script's `export const meta = {...}`
// WITHOUT executing it — same tolerant scan as parsePhases. null when absent
// or unparseable.
export function parseMetaDescription(scriptSource) {
  try {
    if (typeof scriptSource !== 'string') return null
    const metaStart = scriptSource.search(/export\s+const\s+meta\s*=\s*\{/)
    if (metaStart < 0) return null
    const metaBody = scanBalanced(scriptSource, scriptSource.indexOf('{', metaStart), '{', '}')
    if (metaBody === null) return null
    return stringProp(metaBody, 'description')
  } catch { return null }
}

const TITLE_MAX = 42

// Best human name for an agent. An explicit label always wins; otherwise the
// title is distilled from the agent's task prompt (first sentence/clause,
// markdown stripped, paths collapsed to basenames, boilerplate dropped,
// trimmed to TITLE_MAX on a word boundary). null when neither is usable.
// Never throws — this feeds display rows that must degrade per-record.
export function deriveTitle(label, prompt) {
  try {
    if (typeof label === 'string' && label.trim()) return label.trim()
    if (typeof prompt !== 'string') return null
    let s = prompt
      .replace(/^#{1,6}\s+/gm, '')                           // markdown headings
      .replace(/[`*]/g, '')                                  // backticks, emphasis
    s = s.split('\n').map(l => l.trim()).find(l => l) ?? ''
    if (!s) return null
    // Leading boilerplate carries no identity — drop it (a couple of passes
    // handles stacked prefixes like "Step by step, you are ...").
    const boilerplate = /^(?:step by step[,:.\s]+|you are\s+|you own exactly.*?\.\s+|you own\s+|you may.*?\.\s+|read .*?\bfirst\.\s+|context:\s*|do (?:these|the following) steps[,:.\s]*|please\s+)/i
    for (let i = 0; i < 3 && boilerplate.test(s); i++) s = s.replace(boilerplate, '')
    // Absolute and ~ paths collapse to their basename.
    s = s.replace(/(?:~|\/)[^\s`'"()[\]{}]*\/+([^\s`'"()[\]{}/]+)/g, '$1')
    // First sentence; failing that, first clause before an em-dash/semicolon.
    const sentence = s.match(/^(.*?[.!?])(?:\s|$)/)
    s = sentence ? sentence[1] : s.split(/\s+[—–]\s+|;\s+/)[0]
    s = s.replace(/[\s.,;:!?—-]+$/, '').trim()
    if (!/[A-Za-z0-9]/.test(s)) return null
    if (s.length > TITLE_MAX) {
      let cut = s.slice(0, TITLE_MAX - 1)
      const sp = cut.lastIndexOf(' ')
      if (sp > 0) cut = cut.slice(0, sp)
      s = cut.replace(/[\s.,;:!?—-]+$/, '') + '…'
    }
    return s
  } catch { return null }
}

// Live merge for one run. Priority: journal started/result pairing (state) →
// hook events log (precise startedAt) → transcript stat + tail (activity,
// current action, token burn, fallback startedAt). Script source is parsed
// for phases but never returned.
export async function getLiveAgents(runId, { projectsDir = DEFAULT_PROJECTS_DIR, dataDir = null, now = Date.now() } = {}) {
  const agents = new Map()
  const get = id => {
    if (!agents.has(id)) agents.set(id, { agentId: id, state: null, startedAt: null, lastActivityAt: null, currentAction: null, outputTokens: null, transcriptPath: null })
    return agents.get(id)
  }
  let found = false

  // 1. Journal pairing + transcript discovery.
  for (const dir of await findRunAgentDirs(projectsDir)) {
    if (path.basename(dir) !== runId) continue
    found = true
    const { records } = await parseJsonl(path.join(dir, 'journal.jsonl'))
    for (const rec of records) {
      if (!rec || !rec.agentId) continue
      const a = get(rec.agentId)
      if (rec.type === 'started' && a.state !== 'done') a.state = 'running'
      if (rec.type === 'result') a.state = 'done'
    }
    for (const f of await safeReaddir(dir)) {
      const m = f.name.match(/^agent-(.+)\.jsonl$/)
      if (m) get(m[1]).transcriptPath = path.join(dir, f.name)
    }
  }

  // 2. Hook events: SubagentStart gives precise startedAt. A Start carries no
  // run info, so only use it when its agent_id is already known to this run
  // (journal/transcripts) or a Stop's transcript path ties it to this runId.
  if (dataDir) {
    const { records } = await parseJsonl(path.join(dataDir, 'events.jsonl'))
    const stopMatched = new Set()
    for (const e of records) {
      if (e && e.hook_event_name === 'SubagentStop' && e.agent_id &&
          typeof e.agent_transcript_path === 'string' &&
          e.agent_transcript_path.includes(`${path.sep}workflows${path.sep}${runId}${path.sep}`)) {
        stopMatched.add(e.agent_id)
      }
    }
    for (const e of records) {
      if (!e || e.hook_event_name !== 'SubagentStart' || !e.agent_id) continue
      if (typeof e.conductor_logged_at !== 'string') continue
      if (!agents.has(e.agent_id) && !stopMatched.has(e.agent_id)) continue
      const a = get(e.agent_id)
      if (!a.startedAt) a.startedAt = e.conductor_logged_at
    }
  }

  // 3. Transcript stat + tail per agent.
  for (const a of agents.values()) {
    if (!a.transcriptPath) continue
    const st = await safeStat(a.transcriptPath)
    if (st) a.lastActivityAt = new Date(st.mtimeMs).toISOString()
    const tail = await parseTranscriptTail(a.transcriptPath)
    a.currentAction = tail.currentAction
    a.outputTokens = tail.outputTokens
    a.model = tail.model
    a.stats = tail.stats
    a.promptPreview = await readTranscriptPrompt(a.transcriptPath)
    if (!a.startedAt && tail.firstTimestamp) a.startedAt = tail.firstTimestamp  // window start ≈ start; hook data is preferred
  }

  // 4. Phases from the run's script (source never returned).
  const src = await getScript(runId, { projectsDir })
  const phases = src.found ? parsePhases(src.script) : []
  const labelPairs = src.found ? parseAgentLabels(src.script) : []
  const workflowName = src.found ? (src.script.match(/name:\s*['"]([^'"]+)['"]/)?.[1] ?? null) : null

  const rows = [...agents.values()].map(a => {
    const startedMs = a.startedAt ? Date.parse(a.startedAt) : NaN
    const lastMs = a.lastActivityAt ? Date.parse(a.lastActivityAt) : NaN
    const endMs = a.state === 'running' ? now : lastMs
    return {
      agentId: a.agentId,
      state: a.state,
      startedAt: a.startedAt,
      elapsedMs: Number.isFinite(startedMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startedMs) : null,
      lastActivityAt: a.lastActivityAt,
      quietMs: a.state === 'running' && Number.isFinite(lastMs) ? Math.max(0, now - lastMs) : null,
      isFresh: Number.isFinite(lastMs) && now - lastMs < FRESH_WINDOW_MS,
      currentAction: a.currentAction,
      outputTokens: a.outputTokens,
      model: a.model ?? null,
      promptPreview: a.promptPreview ?? null,
      title: null,                 // resolved below (deep-read label match, cached)
      titleSource: 'label',
      stats: a.stats ?? null,
      transcriptPath: a.transcriptPath,
    }
  })

  for (const r of rows) {
    if (!r.title && labelPairs.length && r.transcriptPath) {
      const ck = runId + '/' + r.agentId
      if (labelMatchCache.has(ck)) r.title = labelMatchCache.get(ck)
      else {
        // task-specific text can sit far past the display window (huge
        // shared preambles) — deep-read just for matching, then cache forever
        const deep = await readTranscriptPrompt(r.transcriptPath, { maxBytes: 262144, maxChars: 60000 })
        r.title = matchLabel(labelPairs, deep)
        if (r.title) labelMatchCache.set(ck, r.title)
      }
    }
    if (!r.title) { r.title = deriveTitle(null, r.promptPreview ?? null); r.titleSource = 'derived' }
  }
  disambiguateTitles(rows)
  return {
    runId, found, phases, workflowName,
    description: src.found ? parseMetaDescription(src.script) : null,
    agents: rows, script: undefined,
  }
}

// Author labels exist in the script from run start — only the label→agentId
// mapping is missing until the terminal record. Recover it live: extract
// (promptPrefix, label) pairs from agent(...) calls and prefix-match against
// each agent's transcript prompt.
export function parseAgentLabels(scriptSource) {
  const pairs = []
  if (typeof scriptSource !== 'string') return pairs
  const norm = (t) => tidy(t).replace(/\\`/g, '`').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim()
  const re = /label\s*:\s*['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(scriptSource))) {
    const callStart = scriptSource.lastIndexOf('agent(', m.index)
    if (callStart === -1) continue
    // The prompt region is everything between agent( and this label:.
    // Templates may START with ${...} (shared CONTEXT vars), so prefix-only
    // matching fails — collect every static chunk between interpolations and
    // keep the longest as a fingerprint findable ANYWHERE in the prompt.
    const region = scriptSource.slice(callStart + 6, m.index)
    const chunks = region.split(/\$\{[^}]*\}/)
    let best = ''
    for (const c of chunks) {
      const t = norm(c.replace(/^[\s(]*[`'"]/, '').replace(/[`'"][\s\S]*$/, ''))
      if (t.length > best.length) best = t
    }
    if (best.length >= 25) pairs.push({ fragment: best.slice(0, 120), label: m[1] })
  }
  return pairs
}

export function matchLabel(pairs, promptPreview) {
  if (!pairs?.length || typeof promptPreview !== 'string') return null
  const p = promptPreview.replace(/\s+/g, ' ').trim()
  for (const { fragment, label } of pairs) {
    const probe = fragment.slice(0, Math.min(fragment.length, 60))
    if (probe.length >= 25 && p.includes(probe)) return label
  }
  return null
}

// When fallback-derived titles collide within a run (shared prompt preamble),
// re-derive each from the point where its prompt DIVERGES from the others.
export function disambiguateTitles(agents) {
  try {
    const fallbacks = agents.filter(a => a && a.titleSource === 'derived' && typeof a.promptPreview === 'string')
    if (fallbacks.length < 2) return
    const titles = fallbacks.map(a => a.title).filter(Boolean)
    if (new Set(titles).size === titles.length) return
    const prompts = fallbacks.map(a => a.promptPreview)
    let cp = prompts[0] ?? ''
    for (const pr of prompts) { let i = 0; while (i < cp.length && i < pr.length && cp[i] === pr[i]) i++; cp = cp.slice(0, i) }
    const cut = Math.max(0, cp.lastIndexOf(' '))
    if (cut < 20) return
    const proposed = fallbacks.map(a => {
      // the divergence can land mid-word; skip the partial token
      let tail = a.promptPreview.slice(cut).trim()
      const sp = tail.search(/\s/)
      if (sp > 0 && sp < 20 && !/^[A-Z][a-z]/.test(tail)) tail = tail.slice(sp).trim()
      return deriveTitle(null, tail)
    })
    // quality gate: only adopt if the results are real words and distinct;
    // otherwise keep the shared base title with honest #n suffixes
    const good = proposed.every(t => t && t.length >= 12) && new Set(proposed).size === proposed.length
    fallbacks.forEach((a, i) => {
      a.title = good ? proposed[i] : (a.title ? a.title + ' #' + (i + 1) : null)
    })
  } catch { /* titles are cosmetic — never break the listing */ }
}

// The agent's goal: its task prompt is the FIRST line of its transcript
// (type:user). Read only the head of the file — transcripts grow large.
export async function readTranscriptPrompt(filePath, { maxBytes = 32768, maxChars = 4000 } = {}) {
  if (!filePath) return null
  let fh = null
  try {
    fh = await fs.open(filePath, 'r')
    const buf = Buffer.alloc(maxBytes)
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0)
    const firstLine = buf.subarray(0, bytesRead).toString('utf8').split('\n')[0]
    const line = JSON.parse(firstLine)
    if (line?.type !== 'user') return null
    const c = line.message?.content
    let text = null
    if (typeof c === 'string') text = c
    else if (Array.isArray(c)) text = c.find(b => b?.type === 'text' && typeof b.text === 'string')?.text ?? null
    return text ? tidy(text.trim().slice(0, maxChars)) : null
  } catch { return null } finally { if (fh) await fh.close().catch(() => {}) }
}

// Mirrors the CLI's `s` (save) semantics: project scope writes to the nearest
// existing .claude/workflows/ between cwd and the repo root (creating
// cwd/.claude/workflows/ if none exists — v2.1.178 monorepo rule); user scope
// writes to ~/.claude/workflows/. Saved workflows become /<name> commands.
export async function saveAsWorkflow(runId, name, {
  projectsDir = DEFAULT_PROJECTS_DIR,
  cwd = process.cwd(),
  scope = 'project',            // 'project' | 'user'
  force = false,
  homedir = os.homedir(),
} = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return { saved: false, reason: `invalid name "${name}": use kebab-case (letters, digits, hyphens)` }
  }
  const src = await getScript(runId, { projectsDir })
  if (!src.found) return { saved: false, reason: `script not recoverable for ${runId}: ${src.reason}` }

  let dir
  if (scope === 'user') {
    dir = path.join(homedir, '.claude', 'workflows')
  } else {
    dir = null
    let probe = cwd
    while (true) {
      const candidate = path.join(probe, '.claude', 'workflows')
      if (await safeStat(candidate)) { dir = candidate; break }
      const atRepoRoot = await safeStat(path.join(probe, '.git'))
      const parent = path.dirname(probe)
      if (atRepoRoot || parent === probe) break
      probe = parent
    }
    if (!dir) dir = path.join(cwd, '.claude', 'workflows')
  }

  const target = path.join(dir, `${name}.js`)
  if (!force && await safeStat(target)) {
    return { saved: false, reason: `${target} exists — pass force to overwrite`, target }
  }
  await fs.mkdir(dir, { recursive: true })

  // Saved workflows register as commands by meta.name, NOT filename
  // (verified empirically 2026-07-03) — rewrite it to the requested name.
  const metaNameRe = /(export\s+const\s+meta\s*=\s*\{[^]*?name\s*:\s*)(['"])([^'"]*)\2/
  const m = src.script.match(metaNameRe)
  const script = m ? src.script.replace(metaNameRe, `$1$2${name}$2`) : src.script
  await fs.writeFile(target, script)

  return {
    saved: true, target, scope, source: src.source,
    invokeAs: `/${name}`,
    note: m
      ? (m[3] !== name ? `script meta.name rewritten "${m[3]}" → "${name}" (commands register by meta.name)` : null)
      : `no meta.name found to rewrite — the command may register under the script's internal name, not /${name}`,
  }
}
