/**
 * Request-level regression for the orthogonal Smart enhancement.
 *
 * This verifier drives the real compiled DSH agent loop, session store,
 * system-prompt registry, tool runtime, and dsh-tui channel through:
 *
 *   Standard + Smart off -> Smart on -> Smart off -> Smart on
 *
 * The adapter captures each model request together with the live session's
 * request/header and deriveMessages() projection at the exact stream boundary.
 * The test-only dsh-agent-loop dependency supplies the real request engine.
 * DSH_AGENT_LOOP_ENTRY and a sibling deepseek-harness checkout remain useful
 * fallbacks while developing unreleased loop changes.
 *
 * Run after building dsh-tui:
 *   pnpm build
 *   node scripts/verify-smart-request.mjs
 */
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDir, '..')
const testHome = mkdtempSync(join(tmpdir(), 'dsh-tui-smart-request-'))
const workspace = join(testHome, 'workspace')
mkdirSync(workspace)

const isolatedEnvironment = [
  'HOME',
  'USERPROFILE',
  'DSH_HOME',
  'DSH_SMART_RUNTIME_PATH',
]
const originalEnvironment = new Map(isolatedEnvironment.map(name => [name, process.env[name]]))
process.env.HOME = testHome
process.env.USERPROFILE = testHome
process.env.DSH_HOME = join(testHome, '.dsh')
delete process.env.DSH_SMART_RUNTIME_PATH

let failed = 0
let rootContext

function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

function same(left, right) {
  return isDeepStrictEqual(left, right)
}

async function withTimeout(promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function asEntryUrl(value) {
  if (value.startsWith('file:')) return value
  return pathToFileURL(isAbsolute(value) ? value : resolve(repositoryRoot, value)).href
}

function installedAgentLoop() {
  try {
    return import.meta.resolve('@deepseek-ai/dsh-agent-loop')
  } catch {
    return undefined
  }
}

function resolveAgentLoopEntry() {
  const candidates = [
    ...(process.env.DSH_AGENT_LOOP_ENTRY ? [asEntryUrl(process.env.DSH_AGENT_LOOP_ENTRY)] : []),
    installedAgentLoop(),
    pathToFileURL(resolve(repositoryRoot, '..', '..', 'deepseek-harness', 'packages', 'core', 'agent-loop', 'lib', 'index.js')).href,
  ].filter(Boolean)
  const found = candidates.find(url => url.startsWith('file:') && existsSync(fileURLToPath(url)))
  if (found !== undefined) return found
  throw new Error(
    'compiled @deepseek-ai/dsh-agent-loop not found; build a sibling deepseek-harness checkout '
      + 'or set DSH_AGENT_LOOP_ENTRY to its lib/index.js',
  )
}

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(callId, name, args) {
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name, arguments: argumentsJson },
    },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function toolNames(capture) {
  return capture.request.tools.map(tool => tool.name)
}

function headerEvents(capture) {
  return capture.events.filter(event => event.type === 'request/header')
}

function hasEnhancementMetadata(system = '') {
  return system.includes('Smart task routing is active')
}

function localHeader(capture) {
  const start = capture.meta.seedLength ?? 0
  return capture.events.findLast(event => event.type === 'request/header' && event.seq >= start)
}

function assertFullHeader(label, capture, expectedPreset = 'standard') {
  check(`${label}: adapter receives the session's effective request header`,
    capture.header !== undefined
      && capture.request.provider === capture.header.config.provider
      && capture.request.model === capture.header.config.model
      && capture.request.system === capture.header.system
      && same(capture.request.tools, capture.header.tools ?? []))
  check(`${label}: request messages equal deriveMessages() at dispatch`,
    same(capture.request.messages, capture.derived),
    `${capture.request.messages.length} messages`)
  check(`${label}: request/header records stay outside derived messages`,
    headerEvents(capture).length > 0
      && !JSON.stringify(capture.request.messages).includes('request/header'))
  check(`${label}: durable agentPreset remains ${expectedPreset}`, capture.meta.agentPreset === expectedPreset)
}

function assertForkSeed(label, capture, parentId, parentEvents) {
  const expectedSeedLength = parentEvents.length + 1
  check(`${label}: child records parentSession and complete seedLength`,
    capture.meta.parentSession === parentId
      && capture.meta.seedLength === expectedSeedLength,
    `${String(capture.meta.parentSession)} / ${String(capture.meta.seedLength)}`)
  check(`${label}: complete parent event log is the child seed prefix`,
    same(capture.events.slice(0, parentEvents.length), parentEvents),
    `${parentEvents.length} events`)
  check(`${label}: fork boundary is closed by session/end-seed`,
    capture.events[parentEvents.length]?.type === 'session/end-seed')
  const event = localHeader(capture)
  check(`${label}: replacement emits a child-local complete resume header`,
    event?.data.reason === 'resume'
      && event.seq >= expectedSeedLength
      && same(event.data.header, capture.header),
    event === undefined ? 'missing' : `${event.data.reason} at seq ${event.seq}`)
}

function restoreEnvironment() {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

try {
  const agentLoopEntry = resolveAgentLoopEntry()

  // The sibling bundle must use the exact rc.6 dependency instances installed
  // by dsh-tui. Otherwise two Cordis/DSH module graphs would make a passing
  // structural fake look more realistic than it is.
  const redirectedPackages = [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-scope',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/schemastery',
  ]
  const redirects = new Map(redirectedPackages.map(name => [name, import.meta.resolve(name)]))
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = redirects.get(specifier)
      return url === undefined ? nextResolve(specifier, context) : { url, shortCircuit: true }
    },
  })

  const [
    { Context },
    { default: LlmRuntime, LlmAdapter, CallId, createUserMessage },
    { default: SessionStore, SessionId },
    { default: SystemPrompt },
    { default: ToolRuntime, defineContentToolFixture },
    { createScope, bindScopeParent, scopeOf },
    { default: AgentRegistry },
    { default: AgentLoop },
    { createChannel },
    { composePreset },
    { SUPER_INJECTOR_TOOL_NAMES },
  ] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/dsh-llm'),
    import('@deepseek-ai/dsh-session'),
    import('@deepseek-ai/dsh-system-prompt'),
    import('@deepseek-ai/dsh-tools'),
    import('@deepseek-ai/dsh-scope'),
    import('@deepseek-ai/dsh-agent'),
    import(agentLoopEntry),
    import('../lib/types/dsh-adapter/channel.js'),
    import('../lib/types/dsh-adapter/presets.js'),
    import('../lib/types/dsh-adapter/smartRuntime.js'),
  ])

  const responses = [
    textResponse('Fresh Smart Standard response.'),
    textResponse('Fresh Smart Code response.'),
    textResponse('Inherited Smart Flash child response.'),
    textResponse('Promoted Smart Flash child response.'),
    textResponse('Inherited Smart V4 Pro child response.'),
    textResponse('Promoted Smart V4 Pro child response.'),
    textResponse('Active plan response.'),
    textResponse('Active goal response.'),
    toolCallResponse(CallId('smart-request-bootstrap'), 'probe', {}),
    textResponse('Bootstrap complete.'),
    textResponse('Standard response.'),
    textResponse('Smart response.'),
    textResponse('Standard response after Smart.'),
    textResponse('Smart response after re-enable.'),
    textResponse('Standard response after Smart round trip.'),
  ]

  class CapturingAdapter extends LlmAdapter {
    captures = []
    stage = 'bootstrap'

    async resolveModel(provider, model) {
      return { provider, id: model, name: model }
    }

    async * stream(options) {
      const session = rootContext.sessions.get(options.sessionId)
      if (session === undefined) throw new Error(`request session ${String(options.sessionId)} is not live`)
      const response = responses.shift()
      if (response === undefined) throw new Error('capturing adapter response script exhausted')
      this.captures.push({
        stage: this.stage,
        request: {
          provider: options.provider,
          model: options.model,
          sessionId: String(options.sessionId),
          system: options.system ?? '',
          maxTokens: options.maxTokens,
          tools: structuredClone(options.tools ?? []),
          messages: structuredClone(options.messages),
        },
        header: structuredClone(session.requestHeader()),
        derived: structuredClone(session.deriveMessages()),
        events: structuredClone(session.events),
        meta: structuredClone(session.header),
      })
      for (const chunk of response) yield chunk
    }
  }

  const fixtureTool = name => defineContentToolFixture({
    name,
    description: `Request integration fixture: ${name}`,
    parameters: {},
    async execute() {
      return [{ type: 'text', text: `${name}: ok` }]
    },
  })

  const STANDARD = { id: 'standard', trust: 'system', name: 'Standard' }
  const CODE = { id: 'code', trust: 'system', name: 'Code' }
  const DEFAULT_SENTINEL = { id: 'default-sentinel', trust: 'system', name: 'Default sentinel' }
  const PLATFORM_SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'
  const WORKFLOW_TOOL_NAMES = ['exit_plan_mode', 'goal', 'subagent', 'workflow']
  const BASE_TOOL_NAMES = [
    'read', 'write', 'edit', 'glob', 'grep', PLATFORM_SHELL, 'probe', ...WORKFLOW_TOOL_NAMES,
  ]
  const ROUTER_TOOL_NAMES = ['dev_router_status', 'dev_router_mode', 'dev_mode_subagent']

  rootContext = new Context()
  rootContext.provide('loader', Object.freeze({}))
  rootContext.provide('timer', Object.freeze({}))
  rootContext.provide('fs', Object.freeze({ sandboxMode: undefined }))
  await rootContext.plugin(LlmRuntime)
  await rootContext.plugin(SessionStore)
  await rootContext.plugin(SystemPrompt, { persona: 'Host persona that Standard shadows.' })
  await rootContext.plugin(ToolRuntime)
  await rootContext.plugin(AgentRegistry)
  await rootContext.plugin(AgentLoop, { agents: [] })

  const mountCalls = []
  const resolveCalls = []
  const recomposeCalls = []
  const standing = new Map()

  function standingPreset(id) {
    const existing = standing.get(id)
    if (existing !== undefined) return existing
    const key = { preset: id }
    const scope = createScope(rootContext, key)
    const scopedPrompt = scope.ctx.get('systemPrompt')
    const scopedTools = scope.ctx.get('tools')
    if (scopedPrompt === undefined || scopedTools === undefined) {
      throw new Error('fixture standing scope is missing prompt/tool services')
    }
    scopedPrompt.context({
      name: 'runtime-policy-sentinel',
      order: 0,
      text: 'Runtime policy sentinel: workspace-write and approval ask.',
    })
    scopedPrompt.section({
      name: 'deployment:persona',
      order: 0,
      text: id === 'code'
        ? 'Code request-integration persona.'
        : id === 'standard'
          ? 'Standard request-integration persona.'
          : 'Sentinel preset must never be mounted by a Smart replacement.',
    })
    if (id === 'standard') {
      for (const name of BASE_TOOL_NAMES) scopedTools.register(fixtureTool(name))
    } else {
      scopedTools.register(fixtureTool(id === 'code' ? 'code_only' : 'sentinel_tool'))
    }
    standing.set(id, key)
    return key
  }

  rootContext.provide('agentPresets', {
    // A non-Standard default makes an accidental undefined preset observable.
    defaultId: 'default-sentinel',
    async list() {
      return [DEFAULT_SENTINEL, STANDARD, CODE]
    },
    async resolve(id = 'default-sentinel') {
      resolveCalls.push(id)
      if (id === 'standard') return STANDARD
      if (id === 'code') return CODE
      if (id === 'default-sentinel') return DEFAULT_SENTINEL
      throw new Error(`unknown agent preset: ${id}`)
    },
    async mount(agentContext, id = 'default-sentinel') {
      mountCalls.push({ agentContext, id })
      const agentKey = scopeOf(agentContext)
      if (agentKey === undefined) throw new Error('fixture agent context is unscoped')
      bindScopeParent(agentKey, standingPreset(id))
      return id === 'standard' ? STANDARD : id === 'code' ? CODE : DEFAULT_SENTINEL
    },
    async recompose(agentContext, id) {
      recomposeCalls.push({ agentContext, id })
      throw new Error('Smart request transitions must fork, not recompose')
    },
  })

  const adapter = new CapturingAdapter()
  rootContext.llm.registerAdapter(['request-test'], adapter)

  async function directCaptureMessage(handle, stage, message) {
    const before = adapter.captures.length
    adapter.stage = stage
    handle.agent.followup(message)
    await handle.agent.whenIdle()
    const captures = adapter.captures.slice(before).filter(capture => capture.stage === stage)
    if (captures.length !== 1) throw new Error(`${stage}: expected one model request, captured ${captures.length}`)
    return captures[0]
  }

  async function directCapture(handle, stage, text) {
    return await directCaptureMessage(handle, stage, createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
  }

  async function inheritedChild(parent, id, model, preset = 'standard') {
    const base = await composePreset(rootContext, preset, false)
    return await rootContext.agents.create({
      sessionId: SessionId(id),
      meta: {
        cwd: workspace,
        agentPreset: base.agentPreset,
        parentSession: parent.agent.session.id,
        origin: 'subagent',
        delegationDepth: 1,
      },
      agentOptions: { provider: 'request-test', model, subagentDepth: 1 },
      setup: base.setup,
    })
  }

  function addWorkflowSurface(handle, label, plan = false) {
    if (plan) {
      handle.agent.session.append('plan/mode', { active: true })
      handle.agent.ctx.systemPrompt.section({
        name: 'plan:policy',
        order: -50,
        text: `${label} plan workflow sentinel.`,
      })
    }
    handle.agent.ctx.systemPrompt.context({
      name: `${label}-workflow-context`,
      order: 1,
      text: `${label} workflow context sentinel.`,
    })
  }

  const freshStandardComposition = await composePreset(rootContext, 'standard', true)
  const freshStandardHandle = await rootContext.agents.create({
    sessionId: SessionId('smart-request-fresh-standard'),
    meta: { cwd: workspace, agentPreset: freshStandardComposition.agentPreset },
    agentOptions: { provider: 'request-test', model: 'request-model' },
    setup: freshStandardComposition.setup,
  })

  // Keep two independently composed Smart agents alive while the first inbox
  // event is dispatched. Their Router plugins both listen through the root
  // hook table, so this catches missing ownership gates and duplicate guidance.
  const freshCodeComposition = await composePreset(rootContext, 'code', true)
  const freshCodeHandle = await rootContext.agents.create({
    sessionId: SessionId('smart-request-fresh-code'),
    meta: { cwd: workspace, agentPreset: freshCodeComposition.agentPreset },
    agentOptions: { provider: 'request-test', model: 'deepseek-v4-pro' },
    setup: freshCodeComposition.setup,
  })

  const ambiguousFirstText = 'Please help me with this task.'
  const freshStandard = await directCapture(
    freshStandardHandle,
    'fresh-smart-standard',
    ambiguousFirstText,
  )
  assertFullHeader('Fresh Standard + Smart', freshStandard)
  check('Fresh Standard + Smart: exact Anchored shell/editor surface',
    same(toolNames(freshStandard), [PLATFORM_SHELL, 'str_replace_editor']),
    toolNames(freshStandard).join(', '))
  check('Fresh Standard + Smart: prompt is the exact Router Standard persona without metadata',
    freshStandard.request.system === 'You are a helpful software engineer assistant.'
      && !hasEnhancementMetadata(freshStandard.request.system),
    freshStandard.request.system)
  check('Fresh Standard + Smart: runtime policy context is quarantined on the first request',
    !JSON.stringify(freshStandard.request.messages).includes('Runtime policy sentinel'))
  const freshStandardMessages = JSON.stringify(freshStandard.request.messages)
  check('parallel Smart agents: target first request uses its own first inbox text',
    freshStandardMessages.includes(ambiguousFirstText))
  check('parallel Smart agents: weak target receives exactly one Router guidance message',
    (freshStandardMessages.match(/Router: classify this task/g) ?? []).length === 1)
  check('parallel Smart agents: untouched peer receives no Router guidance',
    !JSON.stringify([
      ...freshCodeHandle.agent.inbox.nextTurn,
      ...freshCodeHandle.agent.inbox.nextStep,
    ]).includes('Router: classify this task'))

  const freshCode = await directCapture(
    freshCodeHandle,
    'fresh-smart-code',
    'Build a new web application from scratch.',
  )
  assertFullHeader('Fresh Code + Smart', freshCode, 'code')
  check('Suite issue #13: real first inbox text selects REACT before user/message persistence',
    freshCode.request.system.includes('hands-on software engineer who delivers working output fast'))
  check('Fresh Code + Smart: non-Standard native tool and runtime context remain available',
    toolNames(freshCode).includes('code_only')
      && JSON.stringify(freshCode.request.messages).includes('Runtime policy sentinel'))
  check('Suite issue #13: clear build input receives no weak near-field guidance',
    !JSON.stringify(freshCode.request.messages).includes('Router: classify this task'))

  const smartFlashChildHandle = await inheritedChild(
    freshStandardHandle,
    'smart-request-smart-flash-child',
    'deepseek-v4-flash',
  )
  const smartFlashChild = await directCapture(
    smartFlashChildHandle,
    'smart-flash-child',
    'Please investigate this delegated task.',
  )
  assertFullHeader('Smart inherited Flash subagent', smartFlashChild)
  check('Smart inherited Flash subagent: no enhancement metadata enters the child prompt',
    !hasEnhancementMetadata(smartFlashChild.request.system))
  check('Smart inherited Flash subagent: missing native editor fails open without expanding child tools',
    BASE_TOOL_NAMES.every(name => toolNames(smartFlashChild).includes(name))
      && !toolNames(smartFlashChild).includes('str_replace_editor'))
  const promotedSmartFlashChild = await directCapture(
    smartFlashChildHandle,
    'smart-flash-child-promoted',
    'Continue the delegated task with the complete tool surface.',
  )
  check('Smart inherited Flash subagent: promotion restores host, workflow, and context surfaces',
    toolNames(promotedSmartFlashChild).includes('dev_smart_status')
      && WORKFLOW_TOOL_NAMES.every(name => toolNames(promotedSmartFlashChild).includes(name))
      && JSON.stringify(promotedSmartFlashChild.request.messages).includes('Runtime policy sentinel'),
    toolNames(promotedSmartFlashChild).join(', '))

  const smartV4ProChildHandle = await inheritedChild(
    freshStandardHandle,
    'smart-request-v4-pro-child',
    'deepseek-v4-pro',
  )
  const smartV4ProChild = await directCapture(
    smartV4ProChildHandle,
    'smart-v4-pro-child',
    'Build a new delegated web application.',
  )
  assertFullHeader('Smart inherited V4 Pro subagent', smartV4ProChild)
  check('Smart inherited Pro subagent: build classification adds decision-closure guidance without replacing child persona',
    JSON.stringify(smartV4ProChild.request.messages).includes('Work directly. End each reasoning block')
      && smartV4ProChild.request.system.includes('Standard request-integration persona.'))
  check('Smart inherited Pro subagent: build classification selects shell plus write-first tools',
    [PLATFORM_SHELL, 'read', 'write', 'edit'].every(name => toolNames(smartV4ProChild).includes(name))
      && !toolNames(smartV4ProChild).includes('str_replace_editor'),
    toolNames(smartV4ProChild).join(', '))
  check('Smart inherited Pro subagent: Smart does not impose an output cap',
    smartV4ProChild.request.maxTokens === undefined)
  check('Smart inherited Pro subagent: delegation policy context survives the routed first request',
    JSON.stringify(smartV4ProChild.request.messages).includes('Runtime policy sentinel'))
  const promotedSmartV4ProChild = await directCapture(
    smartV4ProChildHandle,
    'smart-v4-pro-child-promoted',
    'Continue the delegated build with all tools.',
  )
  check('Smart inherited Pro subagent: promotion restores complete workflow and context surfaces',
    WORKFLOW_TOOL_NAMES.every(name => toolNames(promotedSmartV4ProChild).includes(name))
      && JSON.stringify(promotedSmartV4ProChild.request.messages).includes('Runtime policy sentinel'),
    toolNames(promotedSmartV4ProChild).join(', '))

  await smartFlashChildHandle.dispose()
  await smartV4ProChildHandle.dispose()
  await freshStandardHandle.dispose()
  await freshCodeHandle.dispose()

  const planComposition = await composePreset(rootContext, 'standard', true)
  const planHandle = await rootContext.agents.create({
    sessionId: SessionId('smart-request-active-plan'),
    meta: { cwd: workspace, agentPreset: planComposition.agentPreset },
    agentOptions: { provider: 'request-test', model: 'deepseek-v4-pro' },
    setup: planComposition.setup,
  })
  addWorkflowSurface(planHandle, 'Active plan', true)
  planHandle.agent.session.append('plan/mode', { active: true })
  const activePlan = await directCapture(
    planHandle,
    'active-plan',
    'Build the feature while plan mode is active.',
  )
  assertFullHeader('Active plan + Smart', activePlan)
  check('Active plan + Smart: complete plan sections survive without enhancement metadata',
    activePlan.request.system.includes('Active plan plan workflow sentinel.')
      && !hasEnhancementMetadata(activePlan.request.system))
  check('Active plan + Smart: exit, goal, subagent, and workflow tools remain available',
    WORKFLOW_TOOL_NAMES.every(name => toolNames(activePlan).includes(name)),
    toolNames(activePlan).join(', '))
  check('Active plan + Smart: workflow runtime context remains available',
    JSON.stringify(activePlan.request.messages).includes('Active plan workflow context sentinel.'))
  check('Active plan + Smart: Pro routing adds no execute-now guidance',
    !/Work directly|Then act|Router: classify this task/.test(JSON.stringify(activePlan.request.messages)))
  await planHandle.dispose()

  const goalComposition = await composePreset(rootContext, 'standard', true)
  const goalHandle = await rootContext.agents.create({
    sessionId: SessionId('smart-request-active-goal'),
    meta: { cwd: workspace, agentPreset: goalComposition.agentPreset },
    agentOptions: { provider: 'request-test', model: 'request-model' },
    setup: goalComposition.setup,
  })
  addWorkflowSurface(goalHandle, 'Active goal')
  const activeGoal = await directCaptureMessage(
    goalHandle,
    'active-goal',
    createUserMessage({
      content: [{ type: 'text', text: 'Continue the active goal workflow.' }],
      source: {
        kind: 'goal',
        goalId: 'smart-request-goal',
        revision: 1,
        round: 0,
        change: {
          kind: 'goal/change',
          version: 1,
          operation: 'create',
          goal: {
            id: 'smart-request-goal',
            revision: 1,
            objective: 'Complete the request integration fixture',
            phase: 'active',
            maxGoalRounds: 3,
          },
          roundsStarted: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    }),
  )
  assertFullHeader('Active goal + Smart', activeGoal)
  check('Active goal + Smart: complete Standard sections survive without enhancement metadata',
    activeGoal.request.system.includes('Standard request-integration persona.')
      && !hasEnhancementMetadata(activeGoal.request.system))
  check('Active goal + Smart: exit, goal, subagent, and workflow tools remain available',
    WORKFLOW_TOOL_NAMES.every(name => toolNames(activeGoal).includes(name)),
    toolNames(activeGoal).join(', '))
  check('Active goal + Smart: workflow runtime context remains available',
    JSON.stringify(activeGoal.request.messages).includes('Active goal workflow context sentinel.'))
  await goalHandle.dispose()

  const initialComposition = await composePreset(rootContext, 'standard', false)
  const initialHandle = await rootContext.agents.create({
    sessionId: SessionId('smart-request-standard'),
    meta: {
      cwd: workspace,
      ...(initialComposition.agentPreset === undefined
        ? {}
        : { agentPreset: initialComposition.agentPreset }),
    },
    // The channel's model gate (2026-08-16) only enables Smart on
    // V4 routes, so the switch flow under test runs on a V4 Pro route.
    agentOptions: { provider: 'request-test', model: 'deepseek-v4-pro' },
    ...(initialComposition.setup === undefined ? {} : { setup: initialComposition.setup }),
  })

  // Prime one real durable tool/call so Router Standard is in its promoted
  // catalog state. The three captures under test then remain one model request
  // each while still proving the Router management tools are assembled.
  // The wording is a spec-classifier hit ("debug"): on the V4 Pro route the
  // router's pro lane must quantize this to the spec band, whose surface is
  // the single RL persona + editor — the same shape Router Standard serves.
  adapter.stage = 'bootstrap'
  initialHandle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Debug the failing bootstrap fixture.' }],
    source: { kind: 'user' },
  }))
  await initialHandle.agent.whenIdle()
  check('bootstrap: real agent loop executes one tool call and follow-up request',
    adapter.captures.filter(capture => capture.stage === 'bootstrap').length === 2
      && initialHandle.agent.session.events.some(event => event.type === 'tool/call'))

  // Force a new Standard header after bootstrap, so every state under test has
  // a request-local header produced by an actual assembly.
  rootContext.tools.register(fixtureTool('epoch_probe'))

  const channel = createChannel(rootContext, initialHandle.agent, {
    model: 'deepseek-v4-pro',
    provider: 'request-test',
    cwd: workspace,
    agentPreset: 'standard',
    smart: false,
    activity: false,
    contextBar: false,
    handle: initialHandle,
  })

  async function captureRequests(stage, text, expectedRequests) {
    const before = adapter.captures.length
    adapter.stage = stage
    const live = rootContext.agents.get(SessionId(channel.agentId))
    if (live === undefined) throw new Error(`${stage}: channel agent is not live`)
    const started = Promise.withResolvers()
    const disposeStatus = rootContext.on('agent/status', ({ agent, status }) => {
      if (agent === live && status === 'running') started.resolve()
    })
    channel.submit(text)
    await withTimeout(started.promise, `${stage} turn start`)
    disposeStatus()
    await live.whenIdle()
    const captures = adapter.captures.slice(before).filter(capture => capture.stage === stage)
    if (captures.length !== expectedRequests) {
      const tail = live.session.events.slice(-8).map(event =>
        `${event.seq}:${event.type}${event.type === 'turn/end' ? `:${JSON.stringify(event.data.reason)}` : ''}`)
      throw new Error(
        `${stage}: expected ${expectedRequests} model request(s), captured ${captures.length}; `
          + `capture stages=[${adapter.captures.slice(before).map(capture => capture.stage).join(', ')}]; `
          + `event tail=[${tail.join(', ')}]`,
      )
    }
    return captures
  }

  async function captureTurn(stage, text) {
    return (await captureRequests(stage, text, 1))[0]
  }

  function currentLineage(label) {
    const id = channel.agentId
    const live = rootContext.agents.get(SessionId(id))
    if (live === undefined) throw new Error(`${label}: channel agent is not live`)
    return { id, events: structuredClone(live.session.events) }
  }

  const standard = await captureTurn('standard-off-before', 'Continue in Standard without Smart.')
  assertFullHeader('Standard before Smart', standard)
  const standardTools = toolNames(standard)
  check('Standard before Smart: no enhancement metadata', !hasEnhancementMetadata(standard.request.system))
  check('Standard before Smart: base catalog is present',
    [...BASE_TOOL_NAMES, 'epoch_probe'].every(name => standardTools.includes(name)))
  check('Standard before Smart: Router and optional host management tools are absent',
    ROUTER_TOOL_NAMES.every(name => !standardTools.includes(name))
      && SUPER_INJECTOR_TOOL_NAMES.every(name => !standardTools.includes(name))
      && !standardTools.includes('dev_smart_status'))
  check('Standard before Smart: changed assembly emits a complete change header',
    standard.events.findLast(event => event.type === 'request/header')?.data.reason === 'change')

  // Stand in for tools registered by a verified optional host payload. They are
  // global by upstream design; SmartRuntime's real assembly filter must remove
  // every known management name again after Smart is disabled.
  for (const name of SUPER_INJECTOR_TOOL_NAMES) rootContext.tools.register(fixtureTool(name))

  const standardParentId = channel.agentId
  const standardParent = rootContext.agents.get(SessionId(standardParentId))
  if (standardParent === undefined) throw new Error('Standard parent disappeared before Smart switch')
  const standardParentEvents = structuredClone(standardParent.session.events)
  check('Smart on: channel forks a replacement', await channel.switchSmart(true))
  check('Smart on: enhancement state changes without changing agentPreset',
    channel.smart === true && channel.agentPreset === 'standard')

  // Spec-classifier wording ("fix"/"broken"): on the V4 Pro route the router's
  // pro lane serves the spec band's single RL persona, so the Anchored
  // restart assertion below keeps its Router-Standard meaning.
  const smart = await captureTurn('smart-on', 'Fix the broken login flow with the Smart enhancement.')
  assertFullHeader('Smart on', smart)
  assertForkSeed('Smart on', smart, standardParentId, standardParentEvents)
  const smartTools = toolNames(smart)
  check('Smart on: explicit entry restarts the metadata-free Anchored persona',
    smart.request.system === 'You are a helpful software engineer assistant.'
      && !hasEnhancementMetadata(smart.request.system),
    JSON.stringify(smart.request.system.slice(0, 120)))
  check('Smart on: explicit entry uses the exact shell/editor bootstrap surface',
    same(smartTools, [PLATFORM_SHELL, 'str_replace_editor']), smartTools.join(', '))
  check('Smart on: inherited conversation remains available without promoting the new phase',
    JSON.stringify(smart.request.messages).includes('Runtime policy sentinel'))
  check('Smart on: full Router and optional-host management surfaces stay deferred',
    ROUTER_TOOL_NAMES.every(name => !smartTools.includes(name))
      && SUPER_INJECTOR_TOOL_NAMES.every(name => !smartTools.includes(name))
      && !smartTools.includes('dev_smart_status'))
  check('Smart on: Standard request messages are an exact seed prefix',
    smart.request.messages.length > standard.request.messages.length
      && same(smart.request.messages.slice(0, standard.request.messages.length), standard.request.messages))

  const smartParentId = channel.agentId
  const smartParent = rootContext.agents.get(SessionId(smartParentId))
  if (smartParent === undefined) throw new Error('Smart parent disappeared before disable')
  const smartParentEvents = structuredClone(smartParent.session.events)
  check('Smart off: channel forks another replacement', await channel.switchSmart(false))
  check('Smart off: enhancement state changes without changing agentPreset',
    channel.smart === false && channel.agentPreset === 'standard')

  const standardAgain = await captureTurn('standard-off-after', 'Continue in Standard after Smart.')
  assertFullHeader('Standard after Smart', standardAgain)
  assertForkSeed('Smart off', standardAgain, smartParentId, smartParentEvents)
  const standardAgainTools = toolNames(standardAgain)
  check('Standard after Smart: enhancement metadata is absent from the rebuilt system prompt',
    !hasEnhancementMetadata(standardAgain.request.system))
  check('Standard after Smart: Router tools are absent',
    ROUTER_TOOL_NAMES.every(name => !standardAgainTools.includes(name)))
  check('Standard after Smart: every optional host management tool is filtered',
    SUPER_INJECTOR_TOOL_NAMES.every(name => !standardAgainTools.includes(name))
      && !standardAgainTools.includes('dev_smart_status'))
  check('Standard after Smart: native Standard tools remain usable',
    [...BASE_TOOL_NAMES, 'epoch_probe'].every(name => standardAgainTools.includes(name)))
  check('Standard after Smart: Smart-only editor is absent',
    !standardAgainTools.includes('str_replace_editor'))
  check('Standard after Smart: system prompt and tool surface restore exactly',
    standardAgain.request.system === standard.request.system
      && same(standardAgainTools, standardTools))
  check('Standard after Smart: Smart request messages are an exact seed prefix',
    standardAgain.request.messages.length > smart.request.messages.length
      && same(standardAgain.request.messages.slice(0, smart.request.messages.length), smart.request.messages))
  check('Standard after Smart: every new header and model message remains metadata-free',
    headerEvents(standardAgain).every(event => !hasEnhancementMetadata(event.data.header.system))
      && !hasEnhancementMetadata(JSON.stringify(standardAgain.request.messages)))

  const standardAgainParentId = channel.agentId
  const standardAgainParent = rootContext.agents.get(SessionId(standardAgainParentId))
  if (standardAgainParent === undefined) throw new Error('Standard parent disappeared before Smart re-enable')
  const standardAgainParentEvents = structuredClone(standardAgainParent.session.events)
  check('Smart re-enable: channel forks a replacement', await channel.switchSmart(true))
  check('Smart re-enable: state changes without changing agentPreset',
    channel.smart === true && channel.agentPreset === 'standard')

  const smartAgain = await captureTurn('smart-on-again', 'Repair the broken flow after re-enabling Smart.')
  assertFullHeader('Smart after re-enable', smartAgain)
  assertForkSeed('Smart re-enable', smartAgain, standardAgainParentId, standardAgainParentEvents)
  const smartAgainTools = toolNames(smartAgain)
  check('Smart re-enable: metadata-free prompt and Smart bootstrap surface restart exactly',
    smartAgain.request.system === smart.request.system
      && !hasEnhancementMetadata(smartAgain.request.system)
      && same(smartAgainTools, smartTools))
  check('Smart re-enable: Standard request messages are an exact seed prefix',
    smartAgain.request.messages.length > standardAgain.request.messages.length
      && same(
        smartAgain.request.messages.slice(0, standardAgain.request.messages.length),
        standardAgain.request.messages,
      ))

  const smartRoundTripParent = currentLineage('Smart round trip to Standard')
  check('Smart -> Standard: explicit off succeeds', await channel.switchSmart(false))
  const standardAfterRoundTrip = await captureTurn(
    'standard-after-enhancement-round-trip',
    'Continue in Standard after the enhancement round trip.',
  )
  assertFullHeader('Standard after Smart round trip', standardAfterRoundTrip)
  assertForkSeed(
    'Smart -> Standard after round trip',
    standardAfterRoundTrip,
    smartRoundTripParent.id,
    smartRoundTripParent.events,
  )
  check('Smart -> Standard after round trip: native prompt and tools restore exactly',
    standardAfterRoundTrip.request.system === standard.request.system
      && standardAfterRoundTrip.request.maxTokens === undefined
      && same(toolNames(standardAfterRoundTrip), standardTools))

  const idempotentAgent = channel.agentId
  const idempotentResolveCount = resolveCalls.length
  check('Standard idempotence: repeated off commands succeed without another fork',
    await channel.switchSmart(false)
      && channel.agentId === idempotentAgent
      && resolveCalls.length === idempotentResolveCount)

  check('all transition requests keep the same provider/model route',
    [
      standard,
      smart,
      standardAgain,
      smartAgain,
      standardAfterRoundTrip,
    ].every(capture =>
      capture.request.provider === 'request-test' && capture.request.model === 'deepseek-v4-pro'))
  check('Smart transitions never use preset recompose', recomposeCalls.length === 0)
  check('every composition resolves the source preset explicitly',
    resolveCalls.length > 0
      && resolveCalls.every(id => id === 'standard' || id === 'code')
      && resolveCalls.filter(id => id === 'code').length === 1,
    resolveCalls.join(', '))
  check('agents mount their explicit preset and never fall back to the roster default',
    mountCalls.length > 0
      && mountCalls.every(call => call.id === 'standard' || call.id === 'code')
      && mountCalls.filter(call => call.id === 'code').length === 1,
    mountCalls.map(call => call.id).join(', '))
  check('Smart preference writes are isolated under the temporary HOME',
    existsSync(join(testHome, '.dsh-tui', 'smart.json')))
  // Model gate (2026-08-16): Smart accepts the DeepSeek V4 family (V4 Flash
  // and V4 Pro), and a model fork off a gated route drops it instead of
  // mounting it on an untuned model.
  check('model gate: Smart runs on V4 Flash',
    await channel.switchModel('request-test', 'deepseek-v4-flash')
      && await channel.switchSmart(true)
      && channel.smart === true)
  check('model gate: a non-V4 route auto-disables Smart',
    await channel.switchModel('request-test', 'request-model')
      && channel.smart === false)
  check('model gate: Smart is refused on a non-V4 model',
    (await channel.switchSmart(true)) === false)
  check('adapter consumed the exact scripted request count', responses.length === 0)
} catch (error) {
  failed += 1
  console.error(`FAIL: Smart request integration threw\n${error instanceof Error ? error.stack : String(error)}`)
} finally {
  if (rootContext !== undefined) {
    try {
      await rootContext.fiber.dispose()
    } catch (error) {
      failed += 1
      console.error(`FAIL: root context cleanup threw (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  restoreEnvironment()
  rmSync(testHome, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? 'All Smart request integration checks passed.' : `${failed} Smart request integration check(s) failed.`}`)
if (failed > 0) process.exitCode = 1
