#!/usr/bin/env node
// conductor MCP server — stdio transport, zero dependencies.
// Newline-delimited JSON-RPC 2.0 per the MCP spec. Wraps reader.js; contains
// no logic of its own beyond projection (context-cost control, §2.2).

import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { listRuns, getRun, getAgents, getScript, saveAsWorkflow } from './reader.js'

const SERVER_INFO = { name: 'conductor', version: '0.6.0' }
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.CONDUCTOR_DATA_DIR || path.join(os.homedir(), '.claude', 'plugins', 'data', 'conductor-workflows-conductor')
const STATE_FILE = path.join(DATA_DIR, 'dashboard.json')

async function dashboardState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) } catch { return null }
}
async function probe(state) {
  if (!state?.port || !state?.token) return false
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/health?t=${state.token}`, { signal: AbortSignal.timeout(700) })
    const body = await res.json()
    return body?.ok === true && body?.name === 'conductor-dashboard'
  } catch { return false }
}
function urlOf(state) { return `http://127.0.0.1:${state.port}/?t=${state.token}` }
function openBrowser(url) {
  if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
  else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
}

async function startDashboard({ open = true } = {}) {
  let state = await dashboardState()
  if (await probe(state)) {
    if (open) openBrowser(urlOf(state))
    return { running: true, alreadyRunning: true, url: urlOf(state), pid: state.pid, opened: open }
  }
  const token = randomBytes(16).toString('hex')
  const port = Number(process.env.CONDUCTOR_PORT || 7423)
  // Detached + stdio ignored: must never touch this process's MCP stdio
  // channel, and must survive this MCP server (which dies with the session).
  const child = spawn(process.execPath, [path.join(HERE, 'dashboard.js')], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, CONDUCTOR_TOKEN: token, CONDUCTOR_PORT: String(port), CONDUCTOR_DATA_DIR: DATA_DIR },
  })
  child.unref()
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 150))
    state = await dashboardState()
    if (state?.token === token && await probe(state)) {
      if (open) openBrowser(urlOf(state))
      return { running: true, alreadyRunning: false, url: urlOf(state), pid: state.pid, opened: open }
    }
  }
  // Our spawn lost — maybe a concurrent start (another session) won the port.
  // If whoever holds it is a healthy conductor dashboard, that's still success.
  state = await dashboardState()
  if (await probe(state)) {
    if (open) openBrowser(urlOf(state))
    return { running: true, alreadyRunning: true, url: urlOf(state), pid: state.pid, opened: open }
  }
  return { running: false, reason: `dashboard did not become healthy on port ${port} within 3s (port held by a non-conductor process?)` }
}

async function stopDashboard() {
  const state = await dashboardState()
  if (!await probe(state)) return { stopped: false, reason: 'no healthy dashboard found' }
  try {
    await fetch(`http://127.0.0.1:${state.port}/shutdown?t=${state.token}`, { method: 'POST', signal: AbortSignal.timeout(700) })
  } catch { /* it exits mid-response */ }
  return { stopped: true, pid: state.pid }
}

// Compact row projection for chat contexts — full records stay on disk.
function projectRow(r) {
  return {
    runId: r.runId, workflowName: r.workflowName, status: r.status,
    statusRecognized: r.statusRecognized, compat: r.compat,
    agentCount: r.agentCount, totalTokens: r.totalTokens, durationMs: r.durationMs,
    timestamp: r.timestamp, expiresInDays: r.expiresInDays === null ? null : Math.floor(r.expiresInDays),
    summary: r.summary, projectDir: r.projectDir, error: r.error,
  }
}

const TOOLS = [
  {
    name: 'list_runs',
    description: 'List Claude Code dynamic workflow runs read from ~/.claude/projects. Returns compact rows plus live/interrupted candidates (heuristic). Scope "project" filters to the given cwd; "all" spans every project.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Absolute project path for scope=project (defaults to server cwd)' },
        scope: { type: 'string', enum: ['project', 'all'], default: 'project' },
        limit: { type: 'number', default: 10 },
      },
    },
    handler: async (a) => {
      const res = await listRuns({ cwd: a.cwd ?? process.cwd(), scope: a.scope ?? 'project', limit: a.limit ?? 10 })
      return {
        runs: res.runs.map(projectRow),
        liveCandidates: res.liveCandidates,
        omitted: res.omitted, totalRuns: res.totalRuns, projectCount: res.projectCount,
        readErrors: res.errors.length, scope: res.scope,
      }
    },
  },
  {
    name: 'get_run',
    description: 'Fetch one workflow run\'s metadata by runId (wf_*): status, phases, counters, result preview. Never returns the script — use get_script.',
    inputSchema: {
      type: 'object', required: ['runId'],
      properties: { runId: { type: 'string', description: 'Run ID, e.g. wf_a06fc423-6eb' } },
    },
    handler: (a) => getRun(a.runId).then(({ script, ...rest }) => rest),
  },
  {
    name: 'get_agents',
    description: 'Per-agent detail for a run: state/tokens/duration when the record has them, started/finished from the journal otherwise, plus transcript file paths (read those separately and sparingly).',
    inputSchema: {
      type: 'object', required: ['runId'],
      properties: { runId: { type: 'string' } },
    },
    handler: (a) => getAgents(a.runId),
  },
  {
    name: 'save_workflow',
    description: 'Save a run\'s workflow script as a reusable slash command (mirrors pressing "s" in the CLI /workflows panel). Project scope writes to the nearest .claude/workflows/; user scope to ~/.claude/workflows/. The saved workflow is invoked as /<name> in later sessions.',
    inputSchema: {
      type: 'object', required: ['runId', 'name'],
      properties: {
        runId: { type: 'string' },
        name: { type: 'string', description: 'Command name, kebab-case' },
        scope: { type: 'string', enum: ['project', 'user'], default: 'project' },
        cwd: { type: 'string', description: 'Project path for scope=project' },
        force: { type: 'boolean', default: false, description: 'Overwrite an existing saved workflow of the same name' },
      },
    },
    handler: (a) => saveAsWorkflow(a.runId, a.name, { scope: a.scope ?? 'project', cwd: a.cwd ?? process.cwd(), force: a.force ?? false }),
  },
  {
    name: 'export_script',
    description: 'Write a run\'s workflow script to a file and return the path — for re-running via the Workflow tool\'s scriptPath without pulling the (large) source into context.',
    inputSchema: {
      type: 'object', required: ['runId'],
      properties: { runId: { type: 'string' } },
    },
    handler: async (a) => {
      const src = await getScript(a.runId)
      if (!src.found) return { exported: false, reason: src.reason }
      const dir = path.join(DATA_DIR, 'rerun')
      await fs.mkdir(dir, { recursive: true })
      const target = path.join(dir, `${a.runId}.js`)
      await fs.writeFile(target, src.script)
      return { exported: true, scriptPath: target, source: src.source, bytes: src.script.length }
    },
  },
  {
    name: 'start_dashboard',
    description: 'Ensure the conductor live dashboard is running (localhost HTTP+SSE, token-authed) and open it in the user\'s browser. Idempotent: returns the existing instance\'s URL if one is healthy. The dashboard shows all projects\' runs with live updates via filesystem watch.',
    inputSchema: {
      type: 'object',
      properties: { open: { type: 'boolean', default: true, description: 'Also open the URL in the default browser' } },
    },
    handler: (a) => startDashboard({ open: a.open !== false }),
  },
  {
    name: 'stop_dashboard',
    description: 'Stop the running conductor dashboard (it also self-stops after 30 idle minutes).',
    inputSchema: { type: 'object', properties: {} },
    handler: () => stopDashboard(),
  },
  {
    name: 'get_script',
    description: 'Full workflow script source for a run (large: often 5-50 KB). Prefers the copy embedded in the run record; falls back to script files on disk.',
    inputSchema: {
      type: 'object', required: ['runId'],
      properties: { runId: { type: 'string' } },
    },
    handler: (a) => getScript(a.runId),
  },
]

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    })
  }
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS.map(({ handler, ...t }) => t) })
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find(t => t.name === params?.name)
    if (!tool) return replyError(id, -32602, `unknown tool: ${params?.name}`)
    try {
      const result = await tool.handler(params.arguments ?? {})
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] })
    } catch (err) {
      // Reader degrades per-record; reaching here is a bug — report, don't crash the server.
      return reply(id, { content: [{ type: 'text', text: JSON.stringify({ error: String(err?.stack || err) }) }], isError: true })
    }
  }
  if (id !== undefined) replyError(id, -32601, `method not found: ${method}`)
}

// Exit only after in-flight handlers finish: stdin can close while a
// tools/call is still reading disk, and its response must still be written.
let inFlight = 0
let stdinClosed = false
function maybeExit() { if (stdinClosed && inFlight === 0) process.exit(0) }

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  inFlight++
  handle(msg).catch(() => { /* never crash the protocol loop */ }).finally(() => { inFlight--; maybeExit() })
})
rl.on('close', () => { stdinClosed = true; maybeExit() })
