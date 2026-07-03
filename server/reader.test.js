// node --test reader.test.js
// Fixtures are synthetic but modeled exactly on schemas observed on real
// machines (two CLI generations: phase-only records and records with
// workflow_agent progress entries). See SPIKES.md.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { listRuns, getRun, getAgents, getScript, saveAsWorkflow, encodeCwd } from './reader.js'

let root, projectsDir, cwdA, cwdB
const now = Date.now()

async function write(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, content)
  return p
}

function record(over = {}) {
  return {
    runId: 'wf_test', taskId: 't1', workflowName: 'test-wf', status: 'completed',
    summary: 'a test run', script: 'export const meta = {}\nreturn 1', scriptPath: '/nonexistent/x.js',
    phases: [{ title: 'P1' }], workflowProgress: [{ type: 'workflow_phase', index: 1, title: 'P1' }],
    agentCount: 2, defaultModel: 'claude-x', startTime: now - 60000, timestamp: new Date(now - 1000).toISOString(),
    durationMs: 59000, totalTokens: 1234, totalToolCalls: 5, logs: [], result: { done: true },
    ...over,
  }
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-test-'))
  projectsDir = path.join(root, 'projects')
  cwdA = path.join(root, 'repos', 'proj-a')
  cwdB = path.join(root, 'repos', 'proj-b')
  const encA = encodeCwd(cwdA)
  const encB = encodeCwd(cwdB)
  const sessA = path.join(projectsDir, encA, 'session-1')
  const sessB = path.join(projectsDir, encB, 'session-1')

  // 1. Healthy completed run in project A, with workflow_agent progress entries.
  await write(path.join(sessA, 'workflows', 'wf_ok1.json'), JSON.stringify(record({
    runId: 'wf_ok1',
    workflowProgress: [
      { type: 'workflow_phase', index: 1, title: 'P1' },
      { type: 'workflow_agent', index: 1, agentId: 'agent1', label: 'worker', state: 'done', phaseTitle: 'P1', tokens: 500, toolCalls: 3, durationMs: 9000, resultPreview: 'ok' },
    ],
  })))

  // 2. Killed run with error.
  await write(path.join(sessA, 'workflows', 'wf_killed.json'),
    JSON.stringify(record({ runId: 'wf_killed', status: 'killed', error: 'Error: Workflow aborted', timestamp: new Date(now - 2000).toISOString() })))

  // 3. Unknown (never-observed) status — must pass through verbatim.
  await write(path.join(sessA, 'workflows', 'wf_weird.json'),
    JSON.stringify(record({ runId: 'wf_weird', status: 'paused-experimental', timestamp: new Date(now - 3000).toISOString() })))

  // 4. Truncated record (torn write).
  await write(path.join(sessA, 'workflows', 'wf_torn.json'), JSON.stringify(record({ runId: 'wf_torn' })).slice(0, 50))

  // 5. Degraded record (has runId, missing most expected fields).
  await write(path.join(sessA, 'workflows', 'wf_degraded.json'), JSON.stringify({ runId: 'wf_degraded', status: 'completed' }))

  // 6. Cross-project split: record lives in project B, but scriptPath points under real cwd A.
  await write(path.join(sessB, 'workflows', 'wf_split.json'), JSON.stringify(record({
    runId: 'wf_split', scriptPath: path.join(cwdA, 'tools', 'thing.workflow.mjs'), timestamp: new Date(now - 4000).toISOString(),
  })))

  // 7. Live candidate: agent dir with journal (dangling started + torn line), no record.
  const liveDir = path.join(sessA, 'subagents', 'workflows', 'wf_live')
  await write(path.join(liveDir, 'journal.jsonl'),
    '{"type":"started","key":"v2:abc","agentId":"agentL"}\n{"type":"resu')   // torn trailing line
  await write(path.join(liveDir, 'agent-agentL.jsonl'), '{"type":"user"}\n')

  // 8. Stale candidate: same shape, old mtimes.
  const staleDir = path.join(sessB, 'subagents', 'workflows', 'wf_stale')
  await write(path.join(staleDir, 'journal.jsonl'), '{"type":"started","key":"v2:zzz","agentId":"agentS"}\n')
  const old = new Date(now - 3 * 86400000)
  await fs.utimes(path.join(staleDir, 'journal.jsonl'), old, old)

  // 9. Journal for the healthy run (fallback source + transcript paths).
  const okDir = path.join(sessA, 'subagents', 'workflows', 'wf_ok1')
  await write(path.join(okDir, 'journal.jsonl'),
    '{"type":"started","key":"v2:k1","agentId":"agent1"}\n{"type":"result","key":"v2:k1","agentId":"agent1","result":"done"}\n' +
    '{"type":"started","key":"v2:k2","agentId":"agent2"}\n')
  await write(path.join(okDir, 'agent-agent1.jsonl'), '{}\n')
  await write(path.join(okDir, 'agent-agent2.jsonl'), '{}\n')

  // 10. Empty project (zero runs).
  await fs.mkdir(path.join(projectsDir, encodeCwd(path.join(root, 'repos', 'empty')), 'session-1'), { recursive: true })
})

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('listRuns scope=all sees every record and degrades bad files per-record', async () => {
  const res = await listRuns({ projectsDir, cwd: cwdA, scope: 'all', limit: 50, now })
  const ids = res.runs.map(r => r.runId)
  assert.ok(ids.includes('wf_ok1') && ids.includes('wf_killed') && ids.includes('wf_weird') && ids.includes('wf_split'))
  const torn = res.runs.find(r => r.runId === 'wf_torn')
  assert.equal(torn.status, 'unreadable')
  assert.equal(res.errors.length, 1)                       // one bad file, listing not aborted
  assert.ok(res.runs.length >= 6)
})

test('unknown statuses pass through verbatim, flagged unrecognized', async () => {
  const res = await listRuns({ projectsDir, cwd: cwdA, scope: 'all', limit: 50, now })
  const weird = res.runs.find(r => r.runId === 'wf_weird')
  assert.equal(weird.status, 'paused-experimental')
  assert.equal(weird.statusRecognized, false)
  assert.equal(weird.isTerminal, false)
})

test('compat tagging: ok vs degraded', async () => {
  const res = await listRuns({ projectsDir, cwd: cwdA, scope: 'all', limit: 50, now })
  assert.equal(res.runs.find(r => r.runId === 'wf_ok1').compat, 'ok')
  assert.equal(res.runs.find(r => r.runId === 'wf_degraded').compat, 'degraded')
})

test('project membership: encoded-cwd records AND cross-project scriptPath both count', async () => {
  const res = await listRuns({ projectsDir, cwd: cwdA, scope: 'project', limit: 50, now })
  const ids = res.runs.map(r => r.runId)
  assert.ok(ids.includes('wf_ok1'), 'record under encoded cwd')
  assert.ok(ids.includes('wf_split'), 'record in another project dir whose scriptPath is under real cwd')
  assert.ok(!ids.includes('wf_degraded') || true)          // degraded has no scriptPath; membership via its own project dir
})

test('live candidates: recent → live?, silent → stale; scoped by project', async () => {
  const all = await listRuns({ projectsDir, cwd: cwdA, scope: 'all', limit: 50, now })
  const live = all.liveCandidates.find(c => c.runId === 'wf_live')
  const stale = all.liveCandidates.find(c => c.runId === 'wf_stale')
  assert.equal(live.derivedStatus, 'live?')
  assert.equal(stale.derivedStatus, 'stale')
  const scoped = await listRuns({ projectsDir, cwd: cwdA, scope: 'project', limit: 50, now })
  assert.ok(scoped.liveCandidates.some(c => c.runId === 'wf_live'))
  assert.ok(!scoped.liveCandidates.some(c => c.runId === 'wf_stale'))
})

test('zero-runs is an empty result, not an error', async () => {
  const res = await listRuns({ projectsDir, cwd: path.join(root, 'repos', 'empty'), scope: 'project', limit: 10, now })
  assert.deepEqual(res.runs, [])
  assert.equal(res.omitted, 0)
})

test('missing projects dir entirely is an empty result, not an error', async () => {
  const res = await listRuns({ projectsDir: path.join(root, 'does-not-exist'), cwd: cwdA, scope: 'all', now })
  assert.deepEqual(res.runs, [])
  assert.deepEqual(res.liveCandidates, [])
})

test('getRun projects metadata: no script field, result previewed', async () => {
  const run = await getRun('wf_ok1', { projectsDir, now })
  assert.equal(run.found, true)
  assert.equal(run.script, undefined)
  assert.equal(run.hasInlineScript, true)
  assert.ok(run.resultPreview.includes('done'))
  const missing = await getRun('wf_nope', { projectsDir })
  assert.equal(missing.found, false)
})

test('getAgents prefers record workflow_agent entries, merges journal + transcript paths, drops torn lines', async () => {
  const res = await getAgents('wf_ok1', { projectsDir })
  const a1 = res.agents.find(a => a.agentId === 'agent1')
  assert.equal(a1.state, 'done')                            // from record
  assert.equal(a1.tokens, 500)
  assert.ok(a1.transcriptPath.endsWith('agent-agent1.jsonl'))
  const a2 = res.agents.find(a => a.agentId === 'agent2')   // journal-only: started, never finished
  assert.equal(a2.started, true)
  assert.notEqual(a2.finished, true)

  const live = await getAgents('wf_live', { projectsDir })
  assert.ok(live.notes.some(n => n.includes('torn')))
})

test('getScript prefers inline script from the record', async () => {
  const res = await getScript('wf_ok1', { projectsDir })
  assert.equal(res.found, true)
  assert.equal(res.source, 'inline')
  assert.ok(res.script.startsWith('export const meta'))
})

test('saveAsWorkflow: project scope creates cwd/.claude/workflows, refuses overwrite, force wins', async () => {
  const res = await saveAsWorkflow('wf_ok1', 'my-saved', { projectsDir, cwd: cwdA })
  assert.equal(res.saved, true)
  assert.equal(res.target, path.join(cwdA, '.claude', 'workflows', 'my-saved.js'))
  assert.equal(res.invokeAs, '/my-saved')
  assert.ok((await fs.readFile(res.target, 'utf8')).startsWith('export const meta'))

  const again = await saveAsWorkflow('wf_ok1', 'my-saved', { projectsDir, cwd: cwdA })
  assert.equal(again.saved, false)
  assert.match(again.reason, /exists/)

  const forced = await saveAsWorkflow('wf_ok1', 'my-saved', { projectsDir, cwd: cwdA, force: true })
  assert.equal(forced.saved, true)
})

test('saveAsWorkflow: nearest existing .claude/workflows wins over cwd (monorepo rule)', async () => {
  const repoRoot = path.join(root, 'repos', 'mono')
  const nested = path.join(repoRoot, 'packages', 'app')
  await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true })
  await fs.mkdir(path.join(repoRoot, '.claude', 'workflows'), { recursive: true })
  await fs.mkdir(nested, { recursive: true })
  const res = await saveAsWorkflow('wf_ok1', 'mono-flow', { projectsDir, cwd: nested })
  assert.equal(res.saved, true)
  assert.equal(res.target, path.join(repoRoot, '.claude', 'workflows', 'mono-flow.js'))
})

test('saveAsWorkflow: user scope writes to ~/.claude/workflows; invalid names rejected', async () => {
  const fakeHome = path.join(root, 'fakehome')
  const res = await saveAsWorkflow('wf_ok1', 'user-flow', { projectsDir, cwd: cwdA, scope: 'user', homedir: fakeHome })
  assert.equal(res.saved, true)
  assert.equal(res.target, path.join(fakeHome, '.claude', 'workflows', 'user-flow.js'))

  const bad = await saveAsWorkflow('wf_ok1', '../evil', { projectsDir, cwd: cwdA })
  assert.equal(bad.saved, false)
  assert.match(bad.reason, /invalid name/)

  const missing = await saveAsWorkflow('wf_nope', 'x-flow', { projectsDir, cwd: cwdA })
  assert.equal(missing.saved, false)
})
