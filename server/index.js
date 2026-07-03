#!/usr/bin/env node
// conductor MCP server — stdio transport, zero dependencies.
// Newline-delimited JSON-RPC 2.0 per the MCP spec. Wraps reader.js; contains
// no logic of its own beyond projection (context-cost control, §2.2).

import { createInterface } from 'node:readline'
import { listRuns, getRun, getAgents, getScript } from './reader.js'

const SERVER_INFO = { name: 'conductor', version: '0.3.0' }

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
