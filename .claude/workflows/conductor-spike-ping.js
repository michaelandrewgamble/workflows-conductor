export const meta = {
  name: 'spike-inline-invoke',
  description: 'M0 spike: verify the Workflow tool accepts an externally supplied script file via scriptPath',
  phases: [{ title: 'Ping', detail: 'single trivial agent proves external script execution' }],
}
phase('Ping')
const r = await agent('Reply with exactly the word PONG and nothing else. Your final text is a return value, not user prose.', { label: 'ping', effort: 'low' })
return { pong: r, provenance: 'script was authored outside the Workflow tool call and loaded via scriptPath' }
