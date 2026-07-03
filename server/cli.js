#!/usr/bin/env node
// Thin M1 shim over reader.js — replaced by the MCP server in M2.
// Usage: node cli.js <list|get|agents|script> [runId] [--all] [--limit N] [--cwd PATH]

import { listRuns, getRun, getAgents, getScript } from './reader.js'

const [cmd, ...rest] = process.argv.slice(2)
const args = { _: [] }
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--all') args.all = true
  else if (rest[i] === '--limit') args.limit = Number(rest[++i])
  else if (rest[i] === '--cwd') args.cwd = rest[++i]
  else args._.push(rest[i])
}

const opts = { cwd: args.cwd ?? process.cwd() }
let out
try {
  if (cmd === 'list') out = await listRuns({ ...opts, scope: args.all ? 'all' : 'project', limit: args.limit ?? 10 })
  else if (cmd === 'get' && args._[0]) out = await getRun(args._[0])
  else if (cmd === 'agents' && args._[0]) out = await getAgents(args._[0])
  else if (cmd === 'script' && args._[0]) out = await getScript(args._[0])
  else {
    console.error('usage: cli.js <list|get|agents|script> [runId] [--all] [--limit N] [--cwd PATH]')
    process.exit(2)
  }
} catch (err) {
  // The reader degrades per-record; anything reaching here is a bug worth surfacing.
  console.error(JSON.stringify({ fatal: String(err && err.stack || err) }))
  process.exit(1)
}
console.log(JSON.stringify(out, null, 1))
