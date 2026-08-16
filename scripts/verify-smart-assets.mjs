import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { readPresetMetadata } from '@deepseek-ai/dsh-agent-presets'

import { apply as applyRouter } from '../smart-assets/router-standard/router-bootstrap-v1.mjs'
import {
  applyPersona,
  bandFor,
  classifyTask,
  coreFor,
  extractText,
  isFlashModel,
  isProModel,
  parseMode,
  personaFor,
  sessionMode,
  testinessFor,
} from '../smart-assets/router-standard/router-core.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = join(root, 'smart-assets')
const routerRoot = join(sourceRoot, 'router-standard')
const manifest = JSON.parse(readFileSync(join(sourceRoot, 'manifest.json'), 'utf8'))

test('smart is packaged as an enhancement asset, not a roster preset', () => {
  assert.deepEqual(Object.keys(manifest.enhancements), ['smart'])
  assert.equal(manifest.presets, undefined)
  assert.deepEqual(readdirSync(routerRoot).sort(), [
    'LICENSE',
    'NOTICE',
    'agent.cordis.yml',
    'preset.yml',
    'router-bootstrap-v1.mjs',
    'router-bootstrap.mjs',
    'router-core.mjs',
  ])

  assert.equal(manifest.enhancements.smart.sources.suite.sha, 'eb1b00da039df34c0ab6012b2c93aadc28de391c')
  assert.equal(manifest.enhancements.smart.sources.suite.latestReviewedSha, 'a09eb0ade28e6ec3b8e5eb22985a14f6bfa1fbe5')
  assert.equal(manifest.enhancements.smart.sources.suite.latestReviewDecision, 'excluded-router-pro-revert')
  assert.equal(manifest.enhancements.smart.sources.router.sha, '7426c9cebc0999961aa6197eb42461d92a3ac3ee')
  assert.equal(manifest.enhancements.smart.sources.router.tag, 'v0.3.0')
  assert.equal(manifest.enhancements.smart.sources.router.sourceDirectory, 'preset/router-standard')
  assert.deepEqual(manifest.enhancements.smart.sources.router.policySourceDirectories, [
    'preset/router-standard',
    'preset/router-pro',
  ])
  assert.equal(manifest.enhancements.smart.sources.router.tagMutable, false)
  assert.equal(manifest.enhancements.smart.sources.router.tagCurrentlyPresent, false)
  assert.equal(manifest.enhancements.smart.sources.router.tagStatusReviewedAt, '2026-08-16')
  assert.equal(manifest.enhancements.smart.sources.modeBoost.sha, 'a9a666a6ec83ae72c6f683300384554e41131880')
  assert.equal(manifest.enhancements.smart.sources.modeBoost.vendored, false)
  assert.equal(manifest.enhancements.smart.sources.injector.vendored, false)
  assert.deepEqual(
    manifest.enhancements.smart.upstreamReview.decisions.map(item => item.ref),
    [
      'dsh-routing-suite@a09eb0a',
      'dsh-routing-suite#16',
      'dsh-routing-suite#17',
      'dsh-routing-suite#15',
      'dsh-routing-suite#13',
      'dsh-routing-suite#12',
      'dsh-routing-suite#11',
      'dsh-routing-suite#6',
      'dsh-routing-suite#10',
      'dsh-routing-suite#1',
      'dsh-router-standard#11',
      'dsh-router-standard#10',
      'dsh-router-standard#8',
      'dsh-router-standard#7',
      'dsh-router-standard#6',
      'dsh-router-standard#5',
      'dsh-router-standard#9',
      'dsh-router-standard#2',
      'dsh-mode-boost@a9a666a',
    ],
  )

  for (const [file, expected] of Object.entries(manifest.enhancements.smart.sources.router.files)) {
    const actual = createHash('sha256').update(readFileSync(join(routerRoot, file))).digest('hex')
    assert.equal(actual, expected, file)
  }
})

test('Router Standard metadata remains parseable by the DSH preset reader', async () => {
  assert.deepEqual(await readPresetMetadata(routerRoot), {
    name: 'Router Standard (experimental)',
    description: 'Task-aware routing — RL-interface restoration: one-sentence persona + shell/editor surface; think-act feedback loops. Full Standard tools after the first tool call.',
  })
})

// These 15 cases mirror router.test.mjs at the router SHA pinned in manifest.json.
test('upstream router-core 1/15: build tasks map to react', () => {
  assert.equal(bandFor(classifyTask('\u{9700}\u{8981}\u{672c}\u{5730}\u{5f00}\u{53d1}\u{4e00}\u{4e2a}\u{9a6c}\u{91cc}\u{5965}\u{7f51}\u{9875}\u{5c0f}\u{6e38}\u{620f}\u{ff0c}\u{53c2}\u{8003}\u{7ecf}\u{5178}\u{539f}\u{7248}')), 'react')
  assert.equal(bandFor(classifyTask('\u{5e2e}\u{6211}\u{5199}\u{4e00}\u{4e2a} Python \u{811a}\u{672c}\u{5904}\u{7406} CSV')), 'react')
  assert.equal(bandFor(classifyTask('\u{4ece}\u{96f6}\u{642d}\u{5efa}\u{4e00}\u{4e2a}\u{7f51}\u{7ad9}')), 'react')
})

test('upstream router-core 2/15: fix tasks map to spec', () => {
  const fix = '\u{4fee}\u{590d}\u{8fd9}\u{4e2a}\u{4ed3}\u{5e93}\u{91cc}\u{7684} bug'
  assert.equal(bandFor(classifyTask(fix)), 'spec')
  assert.equal(bandFor(classifyTask('\u{4e3a}\u{4ec0}\u{4e48}\u{767b}\u{5f55}\u{4e00}\u{76f4}\u{62a5}\u{9519}\u{ff0c}\u{5e2e}\u{6211}\u{6392}\u{67e5}')), 'spec')
  assert.equal(classifyTask(fix), 0)
})

test('upstream router-core 3/15: net build evidence maps to react', () => {
  assert.equal(bandFor(classifyTask('\u{5e2e}\u{6211}\u{5f00}\u{53d1}\u{4e00}\u{4e2a}\u{5c0f}\u{6e38}\u{620f}\u{7136}\u{540e}\u{4fee}\u{590d}\u{91cc}\u{9762}\u{7684} bug')), 'react')
})

test('upstream router-core 4/15: unmatched tasks default to weak', () => {
  assert.equal(classifyTask('\u{4eca}\u{5929}\u{5929}\u{6c14}\u{600e}\u{4e48}\u{6837}'), 'weak')
  assert.equal(bandFor('weak'), 'weak')
})

test('upstream router-core 5/15: ties default to weak', () => {
  assert.equal(classifyTask('\u{5e2e}\u{6211}\u{5f00}\u{53d1}\u{4e00}\u{4e2a}\u{5c0f}\u{6e38}\u{620f}\u{7136}\u{540e}\u{4fee}\u{590d}\u{91cc}\u{9762}\u{7684} bug'), 1)
  assert.equal(classifyTask('\u{5f00}\u{53d1}\u{5e76}\u{4fee}\u{590d}'), 'weak')
})

test('upstream router-core 6/15: nested user messages still classify', () => {
  const nested = {
    message: {
      kind: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '\u{628a}\u{76ee}\u{5f55}\u{91cc}\u{7684}\u{5185}\u{5bb9}\u{5185}\u{5316}\u{6210} DSH \u{63d2}\u{4ef6}\u{5e76}\u{6784}\u{5efa}\u{6ce8}\u{5165}' }],
    },
  }
  assert.match(extractText(nested), /\u{5185}\u{5316}\u{6210}/u)
  assert.equal(bandFor(classifyTask(extractText(nested))), 'react')

  const flat = {
    kind: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '\u{4fee}\u{590d}\u{8fd9}\u{4e2a}\u{4ed3}\u{5e93}\u{91cc}\u{7684} bug' }],
  }
  assert.equal(extractText(flat), '\u{4fee}\u{590d}\u{8fd9}\u{4e2a}\u{4ed3}\u{5e93}\u{91cc}\u{7684} bug')
  assert.equal(bandFor(classifyTask(extractText(flat))), 'spec')
  assert.equal(sessionMode({ events: [{ type: 'user/message', data: nested }] }), 1)
})

test('upstream router-core 7/15: weak persona is model-specific', () => {
  const pro = personaFor('weak', 'deepseek-v4-pro')
  const flash = personaFor('weak', 'deepseek-v4-flash')
  assert.ok(pro.includes('Match your working style to the task type'))
  assert.ok(pro.includes('fix the broken login flow'))
  assert.ok(!pro.includes('review what you have already done'))
  assert.ok(flash.includes('decide the task type (build or fix)'))
  assert.ok(flash.includes('review what you have already done'))
  assert.notEqual(pro, flash)
  assert.equal(personaFor('weak', 'deepseek-v4-flash'), personaFor('weak', 'deepseek-v4-flash'))
  assert.equal(isFlashModel('deepseek-v4-flash'), true)
  assert.equal(isFlashModel('deepseek-v4-pro'), false)
  assert.equal(isProModel('deepseek-v4-pro'), true)
  assert.equal(isProModel('deepseek-v4-flash'), false)
  assert.equal(isProModel('other-pro'), false)
})

test('upstream router-core 8/15: parseMode accepts weak', () => {
  assert.equal(parseMode('weak'), 'weak')
  assert.equal(parseMode('router'), 'weak')
})

test('upstream router-core 9/15: persona quantizes to measured bands', () => {
  assert.equal(personaFor(0), 'You are a helpful software engineer assistant.')
  assert.equal(personaFor(0.02), 'You are a helpful software engineer assistant.')
  assert.equal(personaFor(0.3), 'You are a helpful software engineer assistant.')
  assert.ok(personaFor(1).includes('hands-on'))
  assert.ok(personaFor(1).includes('do not build test harnesses'))
})

test('upstream router-core 10/15: core tools vary by band', () => {
  assert.deepEqual(coreFor(0), ['str_replace_editor'])
  assert.deepEqual(coreFor(1), ['read', 'write', 'edit'])
  assert.deepEqual(coreFor(0.3), ['read', 'write', 'edit'])
  assert.deepEqual(coreFor('weak'), ['str_replace_editor'])
})

test('upstream router-core 11/15: phase transition boundaries are stable', () => {
  assert.equal(bandFor(0.02), 'spec')
  assert.equal(bandFor(0.03), 'mixed')
  assert.equal(bandFor(0.454), 'mixed')
  assert.equal(bandFor(0.455), 'react')
  assert.equal(bandFor(0.99), 'react')
})

test('upstream router-core 12/15: testiness rises toward spec', () => {
  assert.equal(testinessFor(1), 'suppressed')
  assert.equal(testinessFor(0), 'normal')
  assert.equal(testinessFor(0.3), 'normal')
})

test('upstream router-core 13/15: parseMode accepts supported tokens', () => {
  assert.equal(parseMode('spec'), 0)
  assert.equal(parseMode('react'), 1)
  assert.equal(parseMode('balanced'), null)
  assert.equal(parseMode('70'), 0.7)
  assert.equal(parseMode('0.3'), 0.3)
  assert.equal(parseMode('auto'), 'auto')
  assert.equal(parseMode('nonsense'), null)
})

test('upstream router-core 14/15: applyPersona preserves plan mode', () => {
  const sections = [
    { name: 'harness-identity', text: 'x', order: -100 },
    { name: 'persona', text: 'old persona', order: 0 },
    { name: 'plan-mode', text: 'You are in plan mode.', order: -50 },
    { name: 'tool-guidance', text: 'y', order: 100 },
  ]
  const out = applyPersona(sections, 'new persona')
  const names = out.map(section => section.name)
  assert.ok(names.includes('harness-identity'))
  assert.ok(names.includes('plan-mode'))
  assert.ok(names.includes('tool-guidance'))
  assert.ok(!names.includes('persona'))
  assert.equal(out.find(section => section.name === 'router-persona').text, 'new persona')
})

test('upstream router-core 15/15: applyPersona accepts empty sections', () => {
  assert.deepEqual(applyPersona([], 'p'), [{ name: 'router-persona', text: 'p', order: 0 }])
})

function routerHarness(
  agentPreset = 'standard',
  id = `smart-${agentPreset}`,
  model = 'deepseek-v4-flash',
  config = {},
) {
  const listeners = new Map()
  const rootListeners = new Map()
  const registeredTools = new Map()
  const appended = []
  const session = {
    id,
    header: { agentPreset },
    events: [],
  }
  const agent = {
    session,
    options: { provider: 'deepseek-official', model },
    inbox: { append(target, message) { appended.push({ target, message }) } },
  }
  const ctx = {
    agent,
    root: {
      on(event, listener) {
        rootListeners.set(event, listener)
        return () => rootListeners.delete(event)
      },
    },
    on(event, listener) { listeners.set(event, listener) },
    effect(register) { return register() },
    tools: {
      register(tool) {
        registeredTools.set(tool.name, tool)
        return () => registeredTools.delete(tool.name)
      },
    },
    get(service) { return service === 'agent' ? agent : undefined },
    llm: { stream() { throw new Error('not used by this regression') } },
  }
  applyRouter(ctx, config)
  return {
    agent,
    appended,
    listeners,
    registeredTools,
    session,
    insert(text, source = { kind: 'user' }) {
      const message = { source, content: [{ type: 'text', text }] }
      rootListeners.get('agent/inbox/inserted')({ agent, message })
      return message
    },
  }
}

test('Smart captures and classifies real inbox text before the first assembly', () => {
  const cases = [
    ['Build a new web application', 'react', 0],
    ['Fix the broken login flow', 'spec', 0],
    ['Please take a look at this request.', 'weak', 1],
  ]
  for (const [text, band, guideCount] of cases) {
    const harness = routerHarness('standard', `first-${band}`)
    const message = harness.insert(text)
    const status = harness.registeredTools.get('dev_router_status').execute()
    assert.match(status, new RegExp(`band=${band}`), text)
    assert.equal(harness.appended.length, guideCount, text)
    if (guideCount === 1) {
      assert.equal(harness.appended[0].target, 'next-step')
      assert.equal(harness.appended[0].message.source.plugin, 'router-bootstrap')
      harness.insert(harness.appended[0].message.content[0].text, harness.appended[0].message.source)
      assert.equal(harness.appended.length, 1, 'plugin guidance must not recurse')
    }
    assert.equal(message.source.kind, 'user')
  }
})

test('V4 Pro Smart routes build, fix, and ambiguous first requests without a budget cap', async () => {
  const cases = [
    {
      id: 'pro-build',
      text: 'Build a new web application.',
      persona: /hands-on software engineer/,
      tools: ['bash', 'read', 'write', 'edit'],
      guide: /Work directly\. End each reasoning block/,
    },
    {
      id: 'pro-fix',
      text: 'Fix the broken login flow.',
      persona: /helpful software engineer assistant/,
      tools: ['bash', 'str_replace_editor'],
      guide: /Think deeply about the task\. End each reasoning block/,
    },
    {
      id: 'pro-weak',
      text: 'Please take a look at this request.',
      persona: /Match your working style to the task type/,
      tools: ['bash', 'str_replace_editor'],
      guide: /Router: classify this task/,
    },
  ]
  for (const expected of cases) {
    const harness = routerHarness('standard', expected.id, 'deepseek-v4-pro')
    harness.insert(expected.text)
    const assembled = await harness.listeners.get('system-prompt/assemble')(
      undefined,
      { agent: harness.agent },
      async () => ({
        sections: [{ name: 'persona', text: 'base' }],
        contexts: [{ name: 'sandbox:policy', text: 'workspace-write' }],
        tools: ['bash', 'str_replace_editor', 'read', 'write', 'edit', 'goal', 'subagent']
          .map(name => ({ name })),
      }),
    )
    assert.deepEqual(assembled.tools.map(tool => tool.name), expected.tools, expected.id)
    assert.match(assembled.sections.find(section => section.name === 'router-persona').text, expected.persona)
    assert.deepEqual(assembled.contexts, [])
    assert.equal(harness.appended.length, 1)
    assert.match(harness.appended[0].message.content[0].text, expected.guide)
  }
})

test('V4 Pro Smart leaves active plan and goal guidance channels untouched', () => {
  const plan = routerHarness('standard', 'pro-active-plan', 'deepseek-v4-pro')
  plan.session.events.push({ type: 'plan/mode', data: { active: true } })
  plan.insert('Build a new application while plan mode is active.')
  assert.equal(plan.appended.length, 0)

  const goal = routerHarness('standard', 'pro-active-goal', 'deepseek-v4-pro')
  goal.session.events.push({
    type: 'user/message',
    data: {
      source: {
        kind: 'goal',
        change: {
          kind: 'goal/change',
          operation: 'create',
          goal: { phase: 'active' },
        },
      },
    },
  })
  goal.insert('Build the next part of the active goal.')
  assert.equal(goal.appended.length, 0)
})

test('Smart routing preserves delegated persona and policy contexts', async () => {
  const harness = routerHarness('standard', 'delegated-pro-build', 'deepseek-v4-pro')
  harness.session.header.origin = 'subagent'
  harness.session.header.parentSession = 'parent'
  harness.insert('Build a new delegated application.')
  const sections = [
    { name: 'deployment:persona', text: 'Delegated specialist.' },
  ]
  const contexts = [
    { name: 'subagent:delegation', text: 'Do not widen permissions.' },
    { name: 'sandbox:policy', text: 'read-only' },
  ]
  const assembled = await harness.listeners.get('system-prompt/assemble')(
    undefined,
    { agent: harness.agent },
    async () => ({
      sections,
      contexts,
      tools: ['bash', 'str_replace_editor', 'read', 'write', 'edit'].map(name => ({ name })),
    }),
  )
  assert.deepEqual(assembled.sections, sections)
  assert.deepEqual(assembled.contexts, contexts)
  assert.deepEqual(assembled.tools.map(tool => tool.name), ['bash', 'read', 'write', 'edit'])
})

test('fresh Standard + Smart exposes the exact RL tools and no runtime contexts', async () => {
  const { agent, listeners } = routerHarness()
  const tools = [
    { name: 'bash' },
    { name: 'str_replace_editor' },
    { name: 'read' },
    { name: 'write' },
    { name: 'edit' },
    { name: 'glob' },
    { name: 'grep' },
    { name: 'todo_write' },
  ]
  const assemble = listeners.get('system-prompt/assemble')
  assert.equal(typeof assemble, 'function')
  const fresh = await assemble(undefined, { agent }, async () => ({
    sections: [{ name: 'persona', text: 'old' }],
    contexts: ['workspace'],
    tools,
  }))
  assert.deepEqual(fresh.tools.map(tool => tool.name), ['bash', 'str_replace_editor'])
  assert.deepEqual(fresh.contexts, [])
  assert.deepEqual(fresh.sections.map(section => section.name), ['router-persona'])
  assert.equal(fresh.sections.find(section => section.name === 'router-persona').text, 'You are a helpful software engineer assistant.')
})

test('a resident but inactive plan:policy section does not disable the router', async () => {
  // dsh-plan-mode registers `plan:policy` permanently; outside plan mode its
  // resolved text is the empty string. A name-only test fails open on every
  // real session and silently disables the whole router (Windows + WSL
  // captures both showed the untouched native prompt).
  const { agent, listeners } = routerHarness()
  const tools = [
    { name: 'bash' },
    { name: 'str_replace_editor' },
    { name: 'read' },
    { name: 'write' },
    { name: 'edit' },
  ]
  const routed = await listeners.get('system-prompt/assemble')(
    undefined,
    { agent },
    async () => ({
      sections: [
        { name: 'persona', text: 'old' },
        { name: 'plan:policy', text: '' },
      ],
      contexts: ['workspace'],
      tools,
    }),
  )
  assert.deepEqual(routed.tools.map(tool => tool.name), ['bash', 'str_replace_editor'])
  assert.deepEqual(routed.sections.map(section => section.name), ['router-persona'])
  assert.deepEqual(routed.contexts, [])
})

test('Smart prompt assembly is scoped to its owning agent', async () => {
  const { listeners } = routerHarness('standard', 'owner')
  const other = {
    session: { id: 'other', header: { agentPreset: 'standard' }, events: [] },
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  }
  const downstream = {
    sections: [{ name: 'persona', text: 'other agent persona' }],
    contexts: [{ name: 'sandbox:policy', text: 'read-only' }],
    tools: [{ name: 'read' }],
  }
  const result = await listeners.get('system-prompt/assemble')(
    undefined,
    { agent: other },
    async () => downstream,
  )
  assert.equal(result, downstream)
})

test('active plan + Smart keeps the complete native workflow surface', async () => {
  const { agent, listeners } = routerHarness()
  const assembled = {
    sections: [{ name: 'persona', text: 'old' }, { name: 'plan:policy', text: 'keep' }],
    contexts: [{ name: 'workflow:runtime', text: 'active' }],
    tools: ['bash', 'str_replace_editor', 'exit_plan_mode', 'goal', 'subagent', 'workflow']
      .map(name => ({ name })),
  }
  const result = await listeners.get('system-prompt/assemble')(
    undefined,
    { agent },
    async () => assembled,
  )
  assert.equal(result, assembled)
})

test('promotion restores the full Standard catalog and runtime contexts', async () => {
  const { agent, listeners, session } = routerHarness()
  const tools = ['bash', 'str_replace_editor', 'read', 'write', 'edit', 'glob', 'grep', 'todo_write'].map(name => ({ name }))
  const contexts = [
    { name: 'sandbox:policy', text: 'workspace-write' },
    { name: 'approval:policy', text: 'ask' },
  ]
  session.events.push({ type: 'tool/call', data: { name: 'bash' } })
  const promoted = await listeners.get('system-prompt/assemble')(
    undefined,
    { agent },
    async () => ({ sections: [{ name: 'persona', text: 'base' }], contexts, tools }),
  )
  assert.deepEqual(promoted.tools, tools)
  assert.deepEqual(promoted.contexts, contexts)
  assert.deepEqual(promoted.sections, [{ name: 'persona', text: 'base' }])
})

test('a tool-less first answer and inherited Smart fork history start promoted', async () => {
  for (const [id, events, seedLength] of [
    ['tool-less', [{ type: 'assistant/message' }, { type: 'turn/end' }], 0],
    ['runtime-fork', [{ type: 'user/message' }, { type: 'session/end-seed' }], 2],
  ]) {
    const { agent, listeners, session } = routerHarness('standard', id)
    session.events.push(...events)
    session.header.seedLength = seedLength
    const assembled = {
      sections: [{ name: 'persona', text: 'base' }, { name: 'plan:policy', text: 'plan' }],
      contexts: [{ name: 'sandbox:policy', text: 'workspace-write' }],
      tools: [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }],
    }
    const result = await listeners.get('system-prompt/assemble')(undefined, { agent }, async () => assembled)
    assert.equal(result, assembled, id)
  }
})

test('explicit Smart entry resets only the inherited Anchored phase', async () => {
  const { agent, listeners, session } = routerHarness(
    'standard',
    'explicit-smart-reset',
    'deepseek-v4-flash',
    { resetAnchored: true },
  )
  session.events.push(
    { type: 'assistant/message' },
    { type: 'session/end-seed' },
  )
  session.header.seedLength = 2
  const result = await listeners.get('system-prompt/assemble')(
    undefined,
    { agent },
    async () => ({
      sections: [{ name: 'persona', text: 'base' }],
      contexts: [{ name: 'sandbox:policy', text: 'workspace-write' }],
      tools: [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' }],
    }),
  )
  assert.deepEqual(result.sections, [{ name: 'router-persona', text: 'You are a helpful software engineer assistant.', order: 0 }])
  assert.deepEqual(result.contexts, [])
  assert.deepEqual(result.tools.map(tool => tool.name), ['bash', 'str_replace_editor'])
})

test('Smart preserves non-Standard native tools and contexts without its editor overlay', async () => {
  for (const agentPreset of ['code', 'minimal', 'cordis', 'custom']) {
    const { agent, listeners } = routerHarness(agentPreset)
    const tools = [
      { name: 'bash' },
      { name: 'read' },
      { name: 'edit' },
      { name: 'code' },
      { name: 'str_replace_editor' },
      { name: 'dev_cordis_inspect' },
    ]
    const assembled = await listeners.get('system-prompt/assemble')(
      undefined,
      { agent },
      async () => ({ sections: [{ name: 'persona', text: 'base' }], contexts: ['native-context'], tools }),
    )
    assert.deepEqual(
      assembled.tools,
      tools.filter(tool => tool.name !== 'str_replace_editor'),
      agentPreset,
    )
    assert.deepEqual(assembled.contexts, ['native-context'], agentPreset)
  }
})

test('blank preset recomposition exposes the owned editor only after switching to Standard', async () => {
  const { agent, listeners, session } = routerHarness('code', 'blank-preset-switch')
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'code' }]
  const downstream = () => ({ sections: [{ name: 'persona', text: 'base' }], contexts: [], tools })
  const code = await listeners.get('system-prompt/assemble')(undefined, { agent }, downstream)
  assert.deepEqual(code.tools.map(tool => tool.name), ['bash', 'code'])

  session.events.push({ type: 'agent-preset/selected', data: { agentPreset: 'standard' } })
  const standard = await listeners.get('system-prompt/assemble')(undefined, { agent }, downstream)
  assert.deepEqual(standard.tools.map(tool => tool.name), ['bash', 'str_replace_editor'])
})

test('shell-less scoped child assembly remains usable', async () => {
  const { agent, listeners, session } = routerHarness('standard', 'shell-less-child')
  session.header.parentSession = 'parent'
  const assembled = { sections: [{ name: 'child', text: 'restricted' }], contexts: ['child-context'], tools: [{ name: 'memory_read' }] }
  const result = await listeners.get('system-prompt/assemble')(
    undefined,
    { agent },
    async () => assembled,
  )
  assert.equal(result, assembled)
})
