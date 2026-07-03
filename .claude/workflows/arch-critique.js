export const meta = {
  name: 'arch-critique',
  description: 'Verify flagged claims and adversarially critique the Workflows Conductor draft architecture',
  phases: [
    { title: 'Verify', detail: 'confirm/refute unverified platform claims against official docs' },
    { title: 'Critique', detail: 'three adversarial lenses attack the draft architecture' },
  ],
}

const DRAFT = '/private/tmp/claude-501/-Users-michaelgamble-GitHub-workflows-conductor/72a10b37-1f38-488b-a25f-95f1c1298654/scratchpad/DRAFT-ARCHITECTURE.md'

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'verdict', 'evidence'],
        properties: {
          claim: { type: 'string' },
          verdict: { type: 'string', enum: ['CONFIRMED', 'REFUTED', 'UNVERIFIABLE'] },
          evidence: { type: 'string', description: 'citation URL or doc section + the exact relevant statement' },
          correction: { type: 'string', description: 'if REFUTED, what is actually true' },
        },
      },
    },
  },
}

const CRITIQUE_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'section', 'problem', 'fix'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          section: { type: 'string' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
    overall: { type: 'string' },
  },
}

const verifiers = [
  {
    label: 'verify:hook-events',
    prompt: `Verify these claims about Claude Code hooks against the OFFICIAL current docs (fetch https://code.claude.com/docs/en/hooks and https://code.claude.com/docs/en/plugins-reference — use WebFetch; do NOT answer from memory):
1. Hook events named "SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted", and "PostToolBatch" exist and are available to plugins.
2. A path variable \${CLAUDE_PLUGIN_DATA} exists for plugin persistent data storage.
3. Hook handler types include "command", "mcp_tool", "http", "prompt", and "agent".
4. Plugin hooks run unsandboxed at user privilege.
For each claim return CONFIRMED / REFUTED / UNVERIFIABLE with the exact doc statement as evidence. List the ACTUAL complete hook event list you find. Also specifically answer: does ANY hook event fire on subagent or workflow lifecycle that a plugin could use to track live workflow runs?`,
  },
  {
    label: 'verify:skill-perms',
    prompt: `Verify these claims against OFFICIAL current Claude Code docs (fetch https://code.claude.com/docs/en/skills, https://code.claude.com/docs/en/plugins, https://code.claude.com/docs/en/plugins-reference, https://code.claude.com/docs/en/permissions via WebFetch; do NOT answer from memory):
1. A plugin skill, at runtime, uses the session's normal tools (Read/Bash) under normal session permission rules — i.e. it CAN read ~/.claude/projects/ if the user permits, with no plugin-specific sandbox confining it to the plugin root.
2. The complete plugin component list is: skills/, commands/, agents/, hooks/, .mcp.json, .lsp.json, monitors/, bin/, settings.json — confirm which of these actually exist as documented plugin components (especially .lsp.json, monitors/, bin/).
3. A plugin .mcp.json supports \${CLAUDE_PLUGIN_ROOT} interpolation and stdio transport, and bundled MCP servers auto-start on plugin enable.
4. Skill frontmatter supports restricting/granting tools (e.g. allowed-tools) — what frontmatter fields are documented?
Return per-claim CONFIRMED/REFUTED/UNVERIFIABLE with exact evidence.`,
  },
  {
    label: 'verify:links-ui',
    prompt: `Verify these claims against OFFICIAL Claude Code docs and the extension changelog (WebFetch https://code.claude.com/docs/en/deep-links, https://code.claude.com/docs/en/vs-code, https://code.claude.com/docs/en/workflows; do NOT answer from memory):
1. Deep link vscode://anthropic.claude-code/open supports params "prompt" and "session".
2. Markdown links printed in Claude Code chat output render clickable in the VS Code extension chat panel (http/https links at minimum).
3. Saved dynamic workflows live at .claude/workflows/<name>.js (project) and ~/.claude/workflows/<name>.js (user), invoked as /<name>, and the docs describe pressing "s" in /workflows to save.
4. Workflow resume works only within the same Claude Code session (exiting starts fresh).
5. There is no documented way to pause/resume/stop a workflow run from outside the owning session.
Return per-claim CONFIRMED/REFUTED/UNVERIFIABLE with exact evidence.`,
  },
]

const critics = [
  {
    label: 'critique:feasibility',
    lens: `TECHNICAL FEASIBILITY. Attack every mechanism: Can a skill really invoke a bundled Node script via Bash in M1 (permissions, node availability)? Will the MCP stdio server design work as described? Is fs.watch on ~/.claude/projects/** viable on macOS (recursive watch, file counts)? Is the liveness heuristic sound or will it misreport? Does the cross-project runId join actually work as specified? Is spawning a long-lived HTTP dashboard from an MCP tool call realistic (process lifecycle when MCP server restarts)?`,
  },
  {
    label: 'critique:ux-honesty',
    lens: `UX HONESTY AND PRODUCT VALUE. Attack every promised user experience: Is anything promised that the surfaces cannot deliver (auto-opening browsers, live updates in chat, clickable links)? Is the resume/pause story honest or will users feel baited? Is chat-markdown run listing actually useful vs noise? Is the dashboard worth 2-3 days vs opening the CLI in the integrated terminal and typing /workflows there — steelman that trivial alternative and judge whether the plugin's value proposition survives it?`,
  },
  {
    label: 'critique:plan-risk',
    lens: `BUILD PLAN AND RISK. Attack sequencing and estimates: missing milestones (error handling, uninstall, versioning against schema drift — the wf_*.json schema is UNDOCUMENTED and Anthropic can change it any release)? Where should schema-drift detection live? Is M1-before-M2 (Bash script then MCP rewrite) wasted work or correct de-risking? What is untested on Cursor until too late? What breaks when cleanupPeriodDays deletes runs mid-view? Missing: how does the plugin behave for a user with ZERO workflow runs?`,
  },
]

phase('Verify')
const verifyResults = parallel(verifiers.map(v => () =>
  agent(v.prompt + '\n\nYour final output is a data report for an orchestrator, not user prose.', {
    label: v.label, phase: 'Verify', schema: VERDICT_SCHEMA, agentType: 'claude-code-guide',
  })
))

phase('Critique')
const critiqueResults = parallel(critics.map(c => () =>
  agent(`Read the draft architecture document at ${DRAFT} (use the Read tool). You are an adversarial reviewer whose job is to find what is WRONG, not to praise. Lens: ${c.lens}\n\nThe draft's Section 1 contains empirically-audited facts from this machine — treat those as ground truth unless internally inconsistent. Attack Sections 2 and 3 (architecture and build plan). Report only findings that would change a decision; severity blocker = architecture/plan is wrong as written, major = will bite during build, minor = polish. Your final output is a data report for an orchestrator.`, {
    label: c.label, phase: 'Critique', schema: CRITIQUE_SCHEMA,
  })
))

const [verified, critiqued] = await Promise.all([verifyResults, critiqueResults])

return {
  verification: verified.filter(Boolean).flatMap(v => v.claims),
  critique: critiqued.filter(Boolean).map((c, i) => ({ lens: critics[i].label, ...c })),
}