/**
 * router-bootstrap: task-aware reasoning-mode router with a continuous
 * react↔spec axis.
 *
 * Reads the session's first user message, classifies the task into a
 * continuous mode in [0,1] (0 = spec plan-first, 1 = react doer), and on the
 * first model request injects the matching persona and first-turn core tool
 * set. After the first durable tool/call the full preset catalog is exposed
 * and nothing is touched again; the mode derives from durable session events,
 * so resume/reload keeps it.
 *
 * The agent can read and tune its own routing through `dev_router_status` and
 * `dev_router_mode` (self-optimization loop) — mode accepts band names
 * (spec/spec-lean/balanced/react-lean/react), 0-100 numbers, or 0.0-1.0.
 *
 * Zero external imports on purpose: relative preset rows resolve bare
 * specifiers from the user home, where `@deepseek-ai/*` is not installed.
 * The router tools therefore inline a minimal schema compiler instead of
 * importing `defineTool` from `@deepseek-ai/dsh-tools`.
 */

import {
  applyPersona, bandFor, bandOf, classifyTask, coreFor, parseMode, personaFor, sessionMode, testinessFor, clamp01,
  extractText, isComplexTask, isFlashModel, isProModel,
} from './router-core.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'router-bootstrap'

/** Prompt assembly, the tools registry, and the LLM route must exist. */
export const inject = ['systemPrompt', 'tools', 'llm']

function agentPresetOf(session) {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type === 'agent-preset/selected') return event.data?.agentPreset
  }
  return session.header?.agentPreset
}

function isPromoted(session, resetAnchored) {
  const start = resetAnchored ? (session.header?.seedLength ?? 0) : 0
  if (!resetAnchored && (session.header?.seedLength ?? 0) > 0) return true
  return session.events.slice(start).some((event) =>
    event.type === 'tool/call'
    || event.type === 'assistant/message'
    || event.type === 'turn/end')
}

function foldGoalActivity(active, source) {
  if (source?.kind !== 'goal') return active
  const change = source.change
  if (change?.kind === 'goal/change') {
    return change.operation !== 'clear' && change.goal?.phase === 'active'
  }
  // Positive rounds are admitted only while the goal driver is active.
  return Number(source.round) > 0 ? true : active
}

function hasActiveGoal(session) {
  let active = false
  for (const event of session.events) {
    if (event.type === 'user/message') active = foldGoalActivity(active, event.data?.source)
  }
  return active
}

function hasActivePlan(session) {
  let active = false
  for (const event of session.events) {
    if (event.type === 'plan/mode') active = event.data?.active === true
  }
  return active
}

/** Minimal spec → JSON Schema compiler (subset of defineTool's work). */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (Array.isArray(meta.enum)) prop.enum = meta.enum
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

export function apply(ctx, config = {}) {
  const owner = ctx.agent
  const owns = agent => owner === undefined || agent === owner
  const resetAnchored = config.resetAnchored === true
  const overrides = new Map() // session id -> explicit mode (number 0..1)
  const agents = new Map() // session id -> Agent (live handle, in-process only)
  const firstUserText = new Map() // session id -> first REAL user message text (issue #3 fix)
  const liveGoalActivity = new Map() // session id -> state observed before user/message persistence

  function routedMode(session) {
    const override = overrides.get(session.id)
    if (override !== undefined) return override
    const text = firstUserText.get(session.id)
    return text === undefined ? sessionMode(session) : classifyTask(text)
  }

  // ── 路由模式（v0.2.0 命名，用户定义）───────────────────────────────────────
  // standard（默认，新）: RL 接口还原——首轮只有 RL 训练句 + shell/str_replace_editor，
  //   模型"想一段、做一段"（实测 25 步 / 24 工具调用 / 产出文件）。
  // spec（旧）: 深度思考优先——分类 persona（w7/REACT/SPEC）+ 保留全部 sections，
  //   模型首轮长思维链（101K 推理 0 行动是其特征，不是缺陷）。
  const configuredRouterMode = config.routerMode === 'pro'
    ? 'pro'
    : config.routerMode === 'spec'
      ? 'spec'
      : config.routerMode === 'standard'
        ? 'standard'
        : 'auto'
  const RL_PERSONA = 'You are a helpful software engineer assistant.'

  function routerModeFor(modelId) {
    if (configuredRouterMode !== 'auto') return configuredRouterMode
    return isProModel(modelId) ? 'pro' : 'standard'
  }

  /** spec 路由模式的首轮工具面（旧行为；weak 也走 default 面）。 */
  function legacyCore(mode) {
    switch (bandOf(mode)) {
      case 'spec': return ['read', 'edit', 'glob', 'grep']
      default: return ['read', 'write', 'edit']
    }
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined || !owns(agent)) return assembled
    const session = agent.session
    agents.set(session.id, agent)

    // The first assembly precedes persistence of user/message. The root inbox
    // listener below captures the real text before assembly so this first,
    // path-committing request is classified correctly.
    const mode = routedMode(session)
    const modelId = agent.options?.model
    const routerMode = routerModeFor(modelId)
    const delegated = session.header?.origin === 'subagent'

    // Plan and goal drivers depend on their complete native prompt, runtime
    // context, and control/delegation catalog. Anchoring must fail open while
    // either workflow is active or the agent can lose its only exit path.
    // `plan:policy` is registered permanently by dsh-plan-mode and only its
    // TEXT is empty outside plan mode — a name-only /plan/i test would fail
    // open on every session and silently disable the whole router.
    const activePlan = hasActivePlan(session)
      || (assembled.sections || []).some((section) =>
        section.name === 'plan:policy' && typeof section.text === 'string' && section.text.trim().length > 0)
    if (activePlan || (liveGoalActivity.get(session.id) ?? hasActiveGoal(session))) return assembled

    // Smart is an overlay over official and user presets. Router Standard's
    // measured RL interface applies only to the Standard base; every other
    // base keeps its native contexts and catalog. The overlay owns an editor
    // at Agent scope so a blank Code -> Standard /preset recompose can enter
    // the RL surface; hide that enhancement-owned tool on other bases.
    if (agentPresetOf(session) !== 'standard') {
      return {
        ...assembled,
        sections: delegated ? assembled.sections : applyPersona(assembled.sections, personaFor(mode, modelId)),
        tools: assembled.tools.filter((tool) => tool.name !== 'str_replace_editor'),
      }
    }

    // ── 模式分派 ──
    // standard（RL 接口还原）: 首轮 system = 只有 RL 训练句；身份/Web 定位/工具引导/
    // 规则 sections 全部移除（minimal 的 complete:true 语义，实测 46 字符 system →
    // 25 步迭代工作流）。
    // spec（深度思考优先）: 分类 persona + 保留全部 sections（首轮超长思维链是特征）。
    let sections
    let core
    let persona
    if (routerMode === 'standard') {
      persona = RL_PERSONA
      sections = [{ name: 'router-persona', text: persona, order: 0 }]
      core = new Set(['str_replace_editor']) // RL shape: shell + editor
    } else if (routerMode === 'pro') {
      // V4 Pro commits to its task interface on the first request. Maintenance
      // uses the measured RL surface; greenfield build keeps the full prompt
      // with a write-first doer surface; ambiguous input uses router-v2 weak.
      persona = personaFor(mode, modelId)
      sections = bandOf(mode) === 'react'
        ? applyPersona(assembled.sections, persona)
        : [{ name: 'router-persona', text: persona, order: 0 }]
      core = new Set(coreFor(mode))
    } else {
      persona = personaFor(mode, modelId)
      sections = applyPersona(assembled.sections, persona) // keep all other sections
      core = new Set(legacyCore(mode))
    }

    if (isPromoted(session, resetAnchored)) {
      // Anchoring is a true first-request surface. A durable tool call, a
      // completed/tool-less response, or an ordinary inherited fork restores
      // the base preset. Explicit Smart entry resets only this phase state.
      return assembled
    }

    const available = new Set(assembled.tools.map((tool) => tool.name))
    const shell = available.has('pwsh') ? 'pwsh' : available.has('bash') ? 'bash' : null
    if (shell === null || [...core].some(name => !available.has(name))) {
      // Scoped child agents may intentionally expose no shell. They inherit
      // the enhancement control plane, but a restricted catalog must remain
      // usable and must never gain a tool the child setup did not allow.
      return assembled
    }
    core.add(shell)

    return {
      ...assembled,
      // Child persona and delegation/sandbox/approval contexts are authority
      // boundaries, not optional prompt decoration. Preserve them while the
      // Router may still narrow an already-allowed compatible tool surface.
      sections: delegated ? assembled.sections : sections,
      contexts: delegated ? assembled.contexts : [],
      tools: assembled.tools.filter((tool) => core.has(tool.name)),
    }
  })

  // ── near-field routing guidance (P14/P16/P17/P19/P20/P30) ───────────────
  // Every REAL user message in a weak-mode session gets ONE fixed guidance
  // message appended to the inbox right after it (near field, cache-neutral).
  // v19: depth-adaptive — SIMPLE tasks get the fast-convergence guide;
  // COMPLEX tasks get the deep-exploration guide (depth-first, information-
  // driven stop signal). The persona carries no hard converge anchor
  // (P27: information-driven convergence beats step-driven; user feedback:
  // flash was over-confident / too shallow on complex tasks).
  const GUIDE_WEAK =
    '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply first, then commit and act. End each reasoning block with a decision or an information need.'
  const GUIDE_DEEP =
    '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply about the architecture, edge cases, and integration points. Do not spend reasoning on the environment or tooling. Produce when your information is complete. End each reasoning block with a decision or an information need.'
  const GUIDE_SPEC =
    '\nThink deeply about the task. End each reasoning block with a decision or an information need. Then act on it.'
  const GUIDE_REACT =
    '\nWork directly. End each reasoning block with a decision or an information need. Then act on it.'
  const GUIDE_FLASH_SPEC = '\nThink deeply first, then commit and act.'
  const GUIDE_FLASH_REACT = '\nWork directly, then verify. Keep the loop tight.'

  // rc.6 dispatches Agent events through the root hook table. A listener on
  // this scoped preset context never sees them. Bind the root listener to the
  // owning Smart agent and dispose it with this plugin so parallel/resumable
  // agents cannot inject duplicate guidance into one another.
  ctx.effect(() => {
    const dispose = ctx.root.on('agent/inbox/inserted', (payload) => {
      const { message, agent } = payload ?? {}
      if (ctx.agent !== agent) return
      const session = agent?.session
      if (session === undefined || agent.inbox === undefined) return
      if (message?.source?.kind === 'goal') {
        const active = liveGoalActivity.get(session.id) ?? hasActiveGoal(session)
        liveGoalActivity.set(session.id, foldGoalActivity(active, message.source))
        return
      }
      if (message?.source?.kind !== 'user') return
      const text = extractText(message).trim()
      if (!text) return
      if (!firstUserText.has(session.id)) firstUserText.set(session.id, text)
      // /plan and /goal own the next-step policy while active. The assembly
      // hook already fails open for their complete tool/context surface; keep
      // the near-field channel equally clean so Pro guidance cannot tell a
      // planning or goal-driven turn to act immediately.
      if (hasActivePlan(session)
        || (liveGoalActivity.get(session.id) ?? hasActiveGoal(session))) return
      const mode = routedMode(session)
      const modelId = agent.options?.model
      const routerMode = routerModeFor(modelId)
      if (routerMode !== 'pro' && bandOf(mode) !== 'weak') return
      const guide = bandOf(mode) === 'weak'
        ? (isComplexTask(text) ? GUIDE_DEEP : GUIDE_WEAK)
        : bandOf(mode) === 'spec'
          ? (isFlashModel(modelId) ? GUIDE_FLASH_SPEC : GUIDE_SPEC)
          : (isFlashModel(modelId) ? GUIDE_FLASH_REACT : GUIDE_REACT)
      try {
        agent.inbox.append('next-step', {
          id: `router-guide-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'user',
          source: { kind: 'plugin', plugin: 'router-bootstrap' },
          content: [{ type: 'text', text: guide }],
        })
      } catch { /* duplicate/ordering races: skip */ }
    })
    return () => { try { dispose() } catch {} }
  })

  // ── router visibility & tuning (agent self-optimization) ────────────────
  const registerTool = (tool) => {
    if (config.registerTools === false) return
    ctx.effect(() => ctx.tools.register({
      ...tool,
      parameters: toJsonSchema(tool.parameters),
      // output.schema is already a plain JSON Schema; keep it as-is
    }))
  }

  const modeSpec = {
    mode: {
      type: 'string',
      required: true,
      description: 'band name (spec / weak / mixed / react), a 0-100 number, a 0.0-1.0 number, or auto to clear the override',
    },
  }

  function fmtMode(mode) {
    return typeof mode === 'string' ? mode : mode.toFixed(2)
  }

  registerTool({
    name: 'dev_router_status',
    description: 'Show this session\'s reasoning-mode routing: mode, band, persona, first-turn core tools, test-suppression, and whether an override is active.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute() {
      const session = currentSession()
      if (session === undefined) return 'no agent session'
      const mode = routedMode(session)
      const modelId = currentAgent()?.options?.model
      const routerMode = routerModeFor(modelId)
      return [
        `router-mode=${routerMode} (auto: Flash/other=standard, V4 Pro=pro)`,
        `mode=${fmtMode(mode)} (band=${bandFor(mode)})`,
        `persona=${personaFor(mode, modelId).replace(/\n/g, ' / ')}`,
        `core=[${coreFor(mode).join(', ')}]`,
        `testiness=${testinessFor(mode)}`,
        `override=${overrides.has(session.id) ? 'yes' : 'no'}`,
      ].join('\n')
    },
  })

  registerTool({
    name: 'dev_router_mode',
    description: 'Set this session\'s reasoning mode: spec (plan-first) / weak (internal routing, model decides per task) / mixed (transition, trap) / react (doer). Accepts band names, 0-100, or 0.0-1.0; use auto to return to task classification. The next request applies it.',
    parameters: modeSpec,
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute(args) {
      const parsed = parseMode(args.mode)
      if (parsed === null) return `invalid mode "${args.mode}": use spec/weak/mixed/react, 0-100, 0.0-1.0, or auto`
      const session = currentSession()
      if (session === undefined) return 'no agent session'
      if (parsed === 'auto') overrides.delete(session.id)
      else overrides.set(session.id, parsed === 'weak' ? 'weak' : clamp01(parsed))
      const current = routedMode(session)
      return `mode=${fmtMode(current)} (band=${bandFor(current)}) — next request applies`
    },
  })

  // ── mode-isolated subagent: run a task in a DIFFERENT reasoning mode,
  //    without touching this session's trajectory (P6 showed tail persona
  //    is ineffective; DSH's native subagent inherits this persona, so the
  //    only working isolation is a fresh LLM call with its own system). ──
  registerTool({
    name: 'dev_mode_subagent',
    description: 'Run one task in a DIFFERENT reasoning mode than this session, in a fresh isolated context (own system prompt). The current session trajectory is untouched. Mode: spec (plan-first) / weak (internal routing) / react (doer) / balanced. Returns the subagent\'s answer text.',
    parameters: {
      mode: { type: 'string', required: true, description: 'spec / weak / react / balanced (or 0-100)' },
      task: { type: 'string', required: true, description: 'the task to hand to the mode-isolated subagent' },
      maxTokens: { type: 'number', description: 'output cap (default 1024)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const parsed = parseMode(args.mode)
      if (parsed === null || parsed === 'auto') return `invalid mode "${args.mode}"`
      const session = currentSession()
      const agent = session === undefined ? undefined : [...agents.values()].find((a) => a.session === session)
      if (agent === undefined || agent.options === undefined) return 'no agent route available'
      const { provider, model } = agent.options
      if (!provider || !model) return 'agent route missing provider/model'

      const persona = personaFor(parsed, model)
      const maxTokens = Number(args.maxTokens || 1024)
      let text = ''
      let reasoningChars = 0
      try {
        const stream = ctx.llm.stream({
          provider,
          model,
          system: persona,
          messages: [{ role: 'user', content: [{ type: 'text', text: String(args.task) }] }],
          maxTokens,
        })
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'reasoning-delta') reasoningChars += chunk.text.length
        }
      } catch (error) {
        return `subagent error: ${error && error.message ? error.message : String(error)}`
      }
      const head = text.slice(0, 3000)
      return `[mode-subagent ${bandFor(parsed)} | reasoning ${reasoningChars} chars]\n${head}${text.length > 3000 ? '\n…(truncated)' : ''}`
    },
  })

  function currentSession() {
    const agent = ctx.get('agent')
    if (agent !== undefined && agent.session !== undefined) return agent.session
    const last = [...agents.values()].at(-1)
    return last?.session
  }

  function currentAgent() {
    const session = currentSession()
    return session === undefined ? undefined : [...agents.values()].find((a) => a.session === session)
  }
}
