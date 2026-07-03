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

  // Live/interrupted candidates: run agent dirs with no record anywhere.
  const recordedIds = new Set(rows.map(r => r.runId))
  const liveCandidates = []
  for (const dir of await findRunAgentDirs(projectsDir)) {
    const runId = path.basename(dir)
    if (recordedIds.has(runId)) continue
    const last = await maxMtime(dir)
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
