/**
 * Claude Agent SDK → Agent Domain translator (docs/agent-backend-design.md
 * §4.4–§4.8, §5.1, with the Phase 0 corrections): one pure state machine per
 * session that turns the SDK message stream (including the frames the SDK
 * types do not declare — `command_lifecycle`, `session_state_changed`,
 * `thinking_tokens` estimates, design appendix B) into `AgentEvent`s for the
 * shared projector. No I/O: the session feeds it messages and the inputs it
 * pushed; fixtures feed it recorded JSON.
 *
 * State: the open turn and its step counter, the open attempt (keyed by the
 * API `message.id`; the CLI sends one `assistant` message per content block,
 * all sharing that id), the open tool calls (their presenters need the
 * input), the inputs this session pushed (their text becomes the user row
 * when the CLI confirms them) and the last `system/init` (re-sent every turn;
 * only changes are emitted).
 *
 * Every field is narrowed from `unknown`; an unknown message type or subtype
 * is ignored (debug-logged), never fatal.
 */
import type { AgentEvent, AgentEventOf, AgentEventType, ContentBlockView, PendingItem, TurnEndReason, UsageDelta } from '../../agent/events.js'
import type { TodoPanelItem } from '../../adapter/ports/channel-view.js'
import { t } from '../../i18n.js'
import { claudeToolRole, presentClaudeToolCall, presentClaudeToolResult } from './tools.js'

/** How confirmed user inputs become user rows. */
export type ClaudeUserRows =
  /** On `command_lifecycle{started}` (CLI capability `msg_lifecycle_v1`). */
  | 'lifecycle'
  /** On the CLI's `user{isReplay:true}` echo of our message (fallback). */
  | 'replay'

export interface ClaudeTranslatorOptions {
  readonly cwd: string
  readonly userRows: ClaudeUserRows
  /** Wall clock for event times (injected by fixtures for determinism). */
  readonly now?: () => number
  readonly debug?: (message: string) => void
}

type Rec = Readonly<Record<string, unknown>>
const rec = (value: unknown): Rec | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Rec : undefined
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const arr = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : []

/** User texts the CLI injects that are not human bubbles. */
const INTERRUPT_ECHO = '[Request interrupted by user'
const LOCAL_COMMAND_TAG = /^<local-command-(stdout|stderr|caveat)>/u
const COMMAND_TAG = /^<command-(name|message|args)>/u
/** Abort diagnostics the CLI appends to `result.errors` (never shown). */
const EDE_DIAGNOSTIC = '[ede_diagnostic]'

/**
 * The Claude backend's decision for every Agent Domain event type (checked by
 * `verify:agent-domain`): a new `AgentEvent` variant fails `tsc` here until
 * this backend decides whether it emits it.
 */
export function claudeEmits(type: AgentEventType): boolean {
  switch (type) {
    case 'session.ready':
    case 'session.title':
    case 'session.reset':
    case 'session.status':
    case 'turn.start':
    case 'turn.end':
    case 'step.start':
    case 'step.end':
    case 'user.message':
    case 'pending.changed':
    case 'assistant.attempt.start':
    case 'assistant.delta':
    case 'assistant.message':
    case 'tool.call':
    case 'tool.result':
    case 'tool.progress':
    case 'subagent.start':
    case 'subagent.progress':
    case 'subagent.end':
    case 'task.start':
    case 'task.update':
    case 'task.end':
    case 'tasks.snapshot':
    case 'compaction.start':
    case 'compaction.end':
    case 'context.capacity':
    case 'model.changed':
    case 'mode.changed':
    case 'commands.changed':
    case 'todo.write':
    case 'notice':
    case 'rate-limit':
      return true
    // Phase 3+ (permission/question bridges, effort, context usage) or not a
    // Claude concept (DSH goals, presets, request headers, system prompt
    // text, plugin events, compaction summary progress, task output reads).
    case 'session.color':
    case 'assistant.attempt.end':
    case 'permission.request':
    case 'permission.settled':
    case 'question.request':
    case 'question.settled':
    case 'task.output':
    case 'compaction.progress':
    case 'context.usage':
    case 'effort.changed':
    case 'goal.change':
    case 'preset.selected':
    case 'system.prompt':
    case 'request.header':
    case 'custom':
      return false
    default: {
      const unhandled: never = type
      return unhandled
    }
  }
}

/** A pushed input awaiting the CLI's confirmation. */
interface RegisteredInput {
  readonly text: string
  readonly placement: PendingItem['placement'] | 'turn' | 'now'
}

/** The attempt (one API response) being assembled. */
interface OpenAttempt {
  readonly id: string
  readonly step: number
  readonly model?: string
  reasoning: string
  text: string
  /** Blocks received via `assistant` messages. */
  blocks: number
  aborted: boolean
  /** Usage from `message_start` / `assistant` (input side). */
  usage: UsageDelta | undefined
  /** Cumulative output tokens from `message_delta`. */
  outputTokens: number | undefined
  /** Stream block index → tool call (for `input_json_delta`). */
  readonly streamTools: Map<number, string>
}

/** Usage of one API response, in the domain's shape. */
function usageOf(value: unknown): UsageDelta | undefined {
  const usage = rec(value)
  if (usage === undefined) return undefined
  const input = num(usage.input_tokens)
  const output = num(usage.output_tokens)
  const cacheRead = num(usage.cache_read_input_tokens)
  const cacheWrite = num(usage.cache_creation_input_tokens)
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined
  return { input, output, cacheRead, cacheWrite }
}

/** Joined text of a tool_result `content` (string or block array). */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  return arr(content).map(block => {
    const value = rec(block)
    return value?.type === 'text' ? str(value.text) ?? '' : ''
  }).join('')
}

/** First text of a user `message.content` (string or block array). */
function userText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  for (const block of arr(content)) {
    const value = rec(block)
    if (value?.type === 'text') return str(value.text)
  }
  return undefined
}

/** Create one translator; it serves exactly one session's stream. */
export function createClaudeTranslator(options: ClaudeTranslatorOptions) {
  const now = options.now ?? Date.now
  const debug = options.debug ?? (() => undefined)
  let userRows = options.userRows
  let seq = 0
  let turn = 0
  let turnOpen = false
  let step = 0
  let stepOpen = false
  let attempt: OpenAttempt | undefined
  /** API message ids already settled (late duplicate blocks are ignored). */
  const settledAttempts = new Set<string>()
  const openCalls = new Map<string, { readonly name: string; readonly input: unknown }>()
  const inputs = new Map<string, RegisteredInput>()
  /** Inputs the channel still shows as queued (pending previews). */
  const pending = new Map<string, PendingItem>()
  let init: { model: string; permissionMode: string | undefined; commands: string } | undefined
  /** The next synthetic user message is a compaction summary. */
  let summaryExpected = false
  /** A `/compact` this session pushed is in flight (manual trigger). */
  let compactRequested = false
  /** A background task just reported: the CLI's next unprompted turn is the
   *  model reacting to it (a notification turn, not a user turn). */
  let notificationTurnExpected = false
  /**
   * What each started task is, from its `task_started`: a subagent, a
   * background job, or a foreground tool's progress report. Its
   * `task_notification` ends exactly that (a foreground Bash ends nothing —
   * its card settles with the tool result).
   */
  const taskKinds = new Map<string, 'agent' | 'job' | 'foreground'>()

  const nextSeq = (): number => ++seq

  const closeStep = (out: AgentEvent[]): void => {
    if (!stepOpen) return
    stepOpen = false
    out.push({ type: 'step.end', turn, step })
  }

  const openTurn = (out: AgentEvent[], origin: AgentEventOf<'turn.start'>['origin'], userMessageId?: string): void => {
    if (turnOpen) return
    turnOpen = true
    turn += 1
    step = 0
    // An unprompted turn right after a task notification is the model
    // reporting on it: a notice stands where a user bubble would be.
    const notified = origin === 'system' && notificationTurnExpected
    notificationTurnExpected = false
    out.push({ type: 'turn.start', turn, origin: notified ? 'notification' : origin, time: now(), ...(userMessageId === undefined ? {} : { userMessageId }) })
    if (notified) out.push({ type: 'notice', level: 'info', text: t('claude-notification-turn') })
  }

  /** Settle the open attempt as one canonical assistant message. */
  const settleAttempt = (out: AgentEvent[]): void => {
    const open = attempt
    if (open === undefined) return
    attempt = undefined
    settledAttempts.add(open.id)
    const blocks: ContentBlockView[] = []
    if (open.reasoning !== '' || open.blocks > 0) blocks.push({ type: 'reasoning', text: open.reasoning })
    if (open.text !== '') blocks.push({ type: 'text', text: open.text })
    const usage = open.usage === undefined && open.outputTokens === undefined
      ? undefined
      : { ...open.usage, ...(open.outputTokens === undefined ? {} : { output: open.outputTokens }) }
    out.push({
      type: 'assistant.message',
      seq: nextSeq(),
      anchor: open.id,
      turn,
      step: open.step,
      attemptId: open.id,
      time: now(),
      ...(open.model === undefined ? {} : { model: open.model }),
      blocks,
      ...(usage === undefined ? {} : { usage }),
      ...(open.aborted ? { interrupted: true as const } : {}),
      canonical: true,
    })
  }

  /** Open an attempt for `id` (a new API response), closing the previous one. */
  const ensureAttempt = (out: AgentEvent[], id: string, model: string | undefined, usage: UsageDelta | undefined): OpenAttempt | undefined => {
    if (attempt?.id === id) return attempt
    if (settledAttempts.has(id)) return undefined
    settleAttempt(out)
    openTurn(out, 'system')
    closeStep(out)
    step += 1
    stepOpen = true
    out.push({ type: 'step.start', turn, step })
    out.push({ type: 'assistant.attempt.start', attemptId: id, turn, step, ...(model === undefined ? {} : { model }) })
    attempt = { id, step, model, reasoning: '', text: '', blocks: 0, aborted: false, usage, outputTokens: undefined, streamTools: new Map() }
    return attempt
  }

  const delta = (open: OpenAttempt, value: AgentEventOf<'assistant.delta'>['delta'], index: number): AgentEvent =>
    ({ type: 'assistant.delta', attemptId: open.id, index, time: now(), delta: value })

  /** The user row for a confirmed input (lifecycle `started` / replay echo). */
  const confirmInput = (out: AgentEvent[], uuid: string): void => {
    const input = inputs.get(uuid)
    if (pending.delete(uuid)) out.push({ type: 'pending.changed', items: [...pending.values()], claimed: [uuid] })
    // Started while a turn is open = folded into that turn (Phase 0 P2-1):
    // a user row, no new turn. Only an input this session pushed makes the
    // turn the user's: an unknown uuid (another client's, a CLI-internal
    // command) opens a system turn.
    if (input === undefined) {
      openTurn(out, 'system')
      return
    }
    openTurn(out, 'user', uuid)
    inputs.delete(uuid)
    if (input.text.trim() === '/compact') return
    out.push({ type: 'user.message', id: uuid, anchor: uuid, seq: nextSeq(), turn, time: now(), source: 'user', text: input.text, blocks: [{ type: 'text', text: input.text }] })
  }

  const translateLifecycle = (message: Rec): AgentEvent[] => {
    const uuid = str(message.command_uuid)
    const state = str(message.state)
    if (uuid === undefined || state === undefined) return []
    const out: AgentEvent[] = []
    switch (state) {
      case 'started':
        if (userRows === 'lifecycle') {
          confirmInput(out, uuid)
          break
        }
        // Echo fallback: the echo brings the row, but the turn is already
        // the user's when the input is one this session pushed.
        if (pending.delete(uuid)) out.push({ type: 'pending.changed', items: [...pending.values()], claimed: [uuid] })
        if (inputs.has(uuid)) openTurn(out, 'user', uuid)
        break
      case 'cancelled':
      case 'discarded':
      case 'refused':
        inputs.delete(uuid)
        if (pending.delete(uuid)) out.push({ type: 'pending.changed', items: [...pending.values()], discarded: [uuid] })
        if (state === 'refused') out.push({ type: 'notice', level: 'warning', text: t('claude-input-refused') })
        break
      default:
        // `queued` (the channel already shows the preview) / `completed`
        // (the turn closes on `result`).
        break
    }
    return out
  }

  const translateInit = (message: Rec): AgentEvent[] => {
    const model = str(message.model) ?? ''
    const permissionMode = str(message.permissionMode)
    const commands = arr(message.slash_commands).filter((name): name is string => typeof name === 'string')
    const out: AgentEvent[] = []
    if (init === undefined) {
      out.push({
        type: 'session.ready',
        sessionId: str(message.session_id) ?? '',
        cwd: str(message.cwd) ?? options.cwd,
        model,
        ...(permissionMode === undefined ? {} : { permissionMode }),
        ...(str(message.claude_code_version) === undefined ? {} : { backendVersion: str(message.claude_code_version) }),
      })
    } else {
      if (model !== '' && model !== init.model) out.push({ type: 'model.changed', model, source: 'settings' })
      if (permissionMode !== undefined && permissionMode !== init.permissionMode) out.push({ type: 'mode.changed', modeId: permissionMode })
      if (commands.join('\n') !== init.commands) out.push({ type: 'commands.changed', commands: commands.map(name => ({ name })) })
    }
    init = { model, permissionMode, commands: commands.join('\n') }
    return out
  }

  const translateStream = (message: Rec): AgentEvent[] => {
    const event = rec(message.event)
    const type = str(event?.type)
    if (event === undefined || type === undefined) return []
    const out: AgentEvent[] = []
    switch (type) {
      case 'message_start': {
        const body = rec(event.message)
        const id = str(body?.id)
        if (id !== undefined) ensureAttempt(out, id, str(body?.model), usageOf(body?.usage))
        return out
      }
      case 'content_block_start': {
        const block = rec(event.content_block)
        const index = num(event.index) ?? 0
        const open = attempt
        if (open === undefined || block?.type !== 'tool_use') return out
        const callId = str(block.id)
        const name = str(block.name)
        if (callId === undefined) return out
        open.streamTools.set(index, callId)
        out.push(delta(open, { kind: 'tool-args', callId, partialJson: '', ...(name === undefined ? {} : { name }) }, index))
        return out
      }
      case 'content_block_delta': {
        const open = attempt
        const body = rec(event.delta)
        const index = num(event.index) ?? 0
        if (open === undefined || body === undefined) return out
        switch (str(body.type)) {
          case 'text_delta': {
            const text = str(body.text) ?? ''
            if (text !== '') out.push(delta(open, { kind: 'text', text }, index))
            return out
          }
          case 'thinking_delta': {
            const text = str(body.thinking) ?? ''
            if (text !== '') out.push(delta(open, { kind: 'reasoning', text }, index))
            const estimated = num(body.estimated_tokens)
            if (text === '' && estimated !== undefined) out.push(delta(open, { kind: 'reasoning-tokens', estimated }, index))
            return out
          }
          case 'input_json_delta': {
            const callId = open.streamTools.get(index)
            const partialJson = str(body.partial_json) ?? ''
            if (callId !== undefined && partialJson !== '') out.push(delta(open, { kind: 'tool-args', callId, partialJson }, index))
            return out
          }
          default:
            // signature_delta / citations_delta: nothing to show.
            return out
        }
      }
      case 'message_delta': {
        const open = attempt
        const output = num(rec(event.usage)?.output_tokens)
        if (open !== undefined && output !== undefined) open.outputTokens = output
        return out
      }
      case 'message_stop':
        settleAttempt(out)
        return out
      default:
        return out
    }
  }

  const translateAssistant = (message: Rec): AgentEvent[] => {
    const body = rec(message.message)
    const id = str(body?.id)
    if (body === undefined || id === undefined) return []
    const out: AgentEvent[] = []
    const open = ensureAttempt(out, id, str(body.model), usageOf(body.usage))
    if (open === undefined) {
      debug(`claude: late block of settled message ${id} ignored`)
      return out
    }
    open.usage ??= usageOf(body.usage)
    if (message.aborted === true) open.aborted = true
    const error = str(message.error)
    if (error !== undefined) out.push({ type: 'notice', level: 'error', text: t('claude-assistant-error', { error }) })
    for (const raw of arr(body.content)) {
      const block = rec(raw)
      if (block === undefined) continue
      open.blocks += 1
      switch (str(block.type)) {
        case 'thinking':
          open.reasoning += str(block.thinking) ?? ''
          break
        case 'redacted_thinking':
          break
        case 'text':
          open.text += str(block.text) ?? ''
          break
        case 'tool_use': {
          const callId = str(block.id)
          const name = str(block.name)
          if (callId === undefined || name === undefined) break
          const input = block.input
          openCalls.set(callId, { name, input })
          const presentation = presentClaudeToolCall(name, input, options.cwd)
          out.push({
            type: 'tool.call',
            seq: nextSeq(),
            anchor: callId,
            turn,
            step: open.step,
            callId,
            name,
            argsJson: JSON.stringify(input ?? {}),
            time: now(),
            ...(presentation === undefined ? {} : { presentation }),
          })
          if (claudeToolRole(name) === 'todo') {
            const todos = arr(rec(input)?.todos).flatMap((item): TodoPanelItem[] => {
              const todo = rec(item)
              const content = str(todo?.content)
              const status = todo?.status
              if (content === undefined || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) return []
              return [{ content, status }]
            })
            out.push({ type: 'todo.write', items: todos })
          }
          break
        }
        default:
          break
      }
    }
    // An aborted response gets no message_stop: it settles here with the
    // prefix it streamed.
    if (open.aborted) settleAttempt(out)
    return out
  }

  const translateUser = (message: Rec): AgentEvent[] => {
    const body = rec(message.message)
    const content = body?.content
    const out: AgentEvent[] = []
    const uuid = str(message.uuid)
    // Our own message echoed back (`--replay-user-messages` fallback).
    if (message.isReplay === true && uuid !== undefined && inputs.has(uuid)) {
      if (userRows === 'replay') confirmInput(out, uuid)
      return out
    }
    const results = arr(content).flatMap(raw => {
      const block = rec(raw)
      return block?.type === 'tool_result' ? [block] : []
    })
    if (results.length > 0) {
      // The open attempt is NOT settled here: the CLI drains finished tool
      // results while the same API message is still streaming (parallel
      // calls), so a later block of that message — another tool_use, more
      // text, the closing usage — still belongs to it. It settles on
      // `message_stop`, a new message id, an abort, `result` or a forced
      // close.
      // `tool_use_result` is message-level: it describes the one result of a
      // single-result message and nothing when several share the message.
      const structured = results.length === 1 ? message.tool_use_result : undefined
      for (const block of results) {
        const callId = str(block.tool_use_id)
        if (callId === undefined) continue
        const call = openCalls.get(callId)
        openCalls.delete(callId)
        const isError = block.is_error === true
        const text = toolResultText(block.content)
        const presentation = call === undefined ? undefined : presentClaudeToolResult(call.name, call.input, { isError, text, structured }, options.cwd)
        out.push({
          type: 'tool.result',
          seq: nextSeq(),
          turn,
          step,
          callId,
          isError,
          time: now(),
          content: typeof block.content === 'string' ? [{ type: 'text', text }] : arr(block.content) as ContentBlockView[],
          text: isError ? '' : text,
          ...(isError ? { errorText: text } : {}),
          ...(structured === undefined ? {} : { structured }),
          ...(presentation === undefined ? {} : { presentation }),
        })
      }
      return out
    }
    const text = userText(content)?.trim()
    if (text === undefined || text === '') return out
    // Abort echoes and local-command transcript records are not bubbles.
    if (text.startsWith(INTERRUPT_ECHO) || LOCAL_COMMAND_TAG.test(text) || COMMAND_TAG.test(text)) return out
    if (message.isSynthetic === true && summaryExpected) {
      summaryExpected = false
      out.push({ type: 'user.message', id: uuid ?? `summary-${seq + 1}`, anchor: uuid ?? '', seq: nextSeq(), turn, time: now(), source: 'compaction', text, blocks: [{ type: 'text', text }] })
      return out
    }
    const origin = str(rec(message.origin)?.kind)
    if (origin !== undefined && origin !== 'human') {
      // A system-originated prompt (task notification, peer, channel): not
      // a human bubble; the turn start already says what happened.
      debug(`claude: ${origin} prompt not projected as a bubble`)
      return out
    }
    debug(`claude: unconfirmed user text not projected (${text.slice(0, 40)})`)
    return out
  }

  /** `result`: the authoritative turn close. */
  const translateResult = (message: Rec): AgentEvent[] => {
    const out: AgentEvent[] = []
    settleAttempt(out)
    closeStep(out)
    const subtype = str(message.subtype)
    const terminal = str(message.terminal_reason)
    const isError = message.is_error === true
    // Phase 0 correction: a `now`-interrupted turn is `subtype:'success'` with
    // `terminal_reason:'aborted_*'` — the terminal reason decides first.
    let reason: TurnEndReason
    if (terminal === 'aborted_streaming' || terminal === 'aborted_tools') reason = { kind: 'aborted' }
    else if (subtype === 'error_max_turns' || subtype === 'error_max_budget_usd' || subtype === 'error_max_structured_output_retries') reason = { kind: 'blocked', detail: subtype }
    else if (subtype === 'success' && !isError) reason = { kind: 'completed' }
    else {
      const errors = arr(message.errors).filter((line): line is string => typeof line === 'string' && !line.startsWith(EDE_DIAGNOSTIC))
      const text = str(message.result) ?? errors.join('\n')
      reason = { kind: 'error', message: text === '' ? (subtype ?? 'error') : text }
    }
    const modelUsage = rec(message.modelUsage)
    // The largest window any model of the turn reported (the main model's;
    // a smaller subagent model never shrinks it).
    const windows = Object.values(modelUsage ?? {}).map(value => num(rec(value)?.contextWindow) ?? 0)
    const contextWindow = Math.max(0, ...windows)
    if (contextWindow > 0) out.push({ type: 'context.capacity', contextWindow })
    const cost = num(message.total_cost_usd)
    if (turnOpen) {
      turnOpen = false
      out.push({
        type: 'turn.end',
        turn,
        reason,
        time: now(),
        ...(cost === undefined ? {} : { cost: { currency: 'USD', amount: cost, source: 'backend' as const } }),
      })
    }
    compactRequested = false
    return out
  }

  const translateSystem = (message: Rec): AgentEvent[] => {
    const subtype = str(message.subtype)
    switch (subtype) {
      case 'init':
        return translateInit(message)
      case 'status': {
        const out: AgentEvent[] = []
        const status = message.status
        if (status === 'requesting') openTurn(out, 'system')
        if (status === 'compacting') out.push({ type: 'compaction.start', trigger: compactRequested ? 'manual' : 'auto', cancellable: false, time: now() })
        if (message.compact_result === 'failed') out.push({ type: 'compaction.end', ok: false, error: str(message.compact_error) ?? '', time: now() })
        const mode = str(message.permissionMode)
        if (mode !== undefined && mode !== init?.permissionMode) {
          if (init !== undefined) init = { ...init, permissionMode: mode }
          out.push({ type: 'mode.changed', modeId: mode })
        }
        return out
      }
      case 'compact_boundary': {
        const meta = rec(message.compact_metadata)
        summaryExpected = true
        return [{
          type: 'compaction.end',
          ok: true,
          ...(num(meta?.pre_tokens) === undefined ? {} : { preTokens: num(meta?.pre_tokens) }),
          ...(num(meta?.post_tokens) === undefined ? {} : { postTokens: num(meta?.post_tokens) }),
          time: now(),
        }]
      }
      case 'thinking_tokens': {
        const open = attempt
        const estimated = num(message.estimated_tokens)
        if (open === undefined || estimated === undefined) return []
        return [delta(open, { kind: 'reasoning-tokens', estimated }, 0)]
      }
      case 'session_state_changed': {
        const state = message.state
        if (state === 'running') return [{ type: 'session.status', status: 'running' }]
        if (state === 'requires_action') return [{ type: 'session.status', status: 'requires-action' }]
        if (state !== 'idle') return []
        // `idle` is the backstop for a turn that never got its `result`.
        const out: AgentEvent[] = []
        if (turnOpen) out.push(...forceCloseTurn({ kind: 'aborted' }))
        out.push({ type: 'session.status', status: 'idle' })
        return out
      }
      case 'task_started': {
        const taskId = str(message.task_id)
        if (taskId === undefined) return []
        const taskType = str(message.task_type)
        const background = message.is_backgrounded === true
        const description = str(message.description) ?? ''
        const callId = str(message.tool_use_id)
        if (taskType === 'local_agent' || str(message.subagent_type) !== undefined) {
          taskKinds.set(taskId, 'agent')
          return [{ type: 'subagent.start', agentId: taskId, ...(callId === undefined ? {} : { parentCallId: callId }), description, ...(str(message.subagent_type) === undefined ? {} : { kind: str(message.subagent_type) }), background, time: now() }]
        }
        // Phase 0 correction: a foreground Bash that runs ~3s also reports
        // `task_started{is_backgrounded:false}` — not a background job.
        if (!background) {
          taskKinds.set(taskId, 'foreground')
          return []
        }
        taskKinds.set(taskId, 'job')
        const kind = taskType === 'local_bash' ? 'shell' : taskType === 'local_workflow' ? 'workflow' : taskType ?? 'task'
        return [{ type: 'task.start', taskId, kind, description, ...(callId === undefined ? {} : { callId }), background: true, time: now() }]
      }
      case 'task_progress': {
        const taskId = str(message.task_id)
        if (taskId === undefined) return []
        const usage = rec(message.usage)
        return [{
          type: 'subagent.progress',
          agentId: taskId,
          ...(str(message.summary) === undefined ? {} : { summary: str(message.summary) }),
          ...(str(message.last_tool_name) === undefined ? {} : { lastTool: str(message.last_tool_name) }),
          ...(usage === undefined ? {} : { usage: { output: num(usage.total_tokens), toolUses: num(usage.tool_uses), durationMs: num(usage.duration_ms) } }),
        }]
      }
      case 'task_updated': {
        const taskId = str(message.task_id)
        const patch = rec(message.patch)
        const status = str(patch?.status)
        if (taskId === undefined || status === undefined) return []
        const mapped = status === 'running' || status === 'pending' || status === 'completed' || status === 'failed' ? status : status === 'killed' || status === 'stopped' ? 'stopped' : undefined
        return mapped === undefined ? [] : [{ type: 'task.update', taskId, patch: { status: mapped } }]
      }
      case 'task_notification': {
        const taskId = str(message.task_id)
        const status = str(message.status)
        if (taskId === undefined) return []
        const summary = str(message.summary)
        const done = status === 'failed' ? 'failed' : status === 'stopped' ? 'stopped' : 'completed'
        // A task never seen starting (missed frame): a usage block is what
        // only subagent reports carry.
        const kind = taskKinds.get(taskId) ?? (message.usage === undefined ? 'job' : 'agent')
        taskKinds.delete(taskId)
        if (kind === 'foreground') return []
        // A foreground tool's task report arrives inside its own turn; only a
        // report between turns starts the CLI's notification turn.
        if (!turnOpen) notificationTurnExpected = true
        return kind === 'agent'
          ? [{ type: 'subagent.end', agentId: taskId, status: done === 'stopped' ? 'cancelled' : done, ...(summary === undefined ? {} : { summary }), time: now() }]
          : [{ type: 'task.end', taskId, status: done, ...(summary === undefined ? {} : { summary }), time: now() }]
      }
      case 'background_tasks_changed': {
        const ids = arr(message.tasks).flatMap(item => {
          const id = str(rec(item)?.task_id) ?? str(rec(item)?.id)
          return id === undefined ? [] : [id]
        })
        return [{ type: 'tasks.snapshot', taskIds: ids }]
      }
      case 'permission_denied':
        return [{ type: 'notice', level: 'warning', text: str(message.message) ?? t('claude-permission-denied', { tool: str(message.tool_name) ?? '' }), ...(str(message.tool_use_id) === undefined ? {} : { callId: str(message.tool_use_id) }) }]
      case 'api_retry':
        return [{ type: 'notice', level: 'notice', key: 'api-retry', text: t('claude-api-retry', { attempt: String(num(message.attempt) ?? '?'), max: String(num(message.max_retries) ?? '?') }) }]
      case 'informational':
      case 'notification': {
        const text = str(message.message) ?? str(message.text) ?? str(message.content)
        if (text === undefined || text === '') return []
        const level = str(message.level)
        return [{ type: 'notice', level: level === 'warning' || level === 'error' ? level : 'info', text }]
      }
      case 'local_command_output': {
        const text = str(message.content) ?? str(message.output)
        return text === undefined || text === '' ? [] : [{ type: 'notice', level: 'info', text }]
      }
      case 'session_title_changed': {
        const title = str(message.title)
        return title === undefined ? [] : [{ type: 'session.title', title, source: 'auto' }]
      }
      case 'commands_changed': {
        const commands = arr(message.commands).flatMap(item => {
          const name = typeof item === 'string' ? item : str(rec(item)?.name)
          return name === undefined ? [] : [{ name }]
        })
        return [{ type: 'commands.changed', commands }]
      }
      case 'model_refusal_fallback': {
        const model = str(message.fallback_model) ?? str(message.model)
        return model === undefined ? [] : [{ type: 'model.changed', model, source: 'fallback' }, { type: 'notice', level: 'warning', text: t('claude-model-fallback', { model }) }]
      }
      default:
        debug(`claude: system/${subtype ?? '?'} ignored`)
        return []
    }
  }

  /** Close an open turn without a `result` (idle backstop, forced settle,
   *  process death). */
  function forceCloseTurn(reason: TurnEndReason): AgentEvent[] {
    const out: AgentEvent[] = []
    settleAttempt(out)
    closeStep(out)
    if (turnOpen) {
      turnOpen = false
      out.push({ type: 'turn.end', turn, reason, time: now() })
    }
    return out
  }

  /** Translate one SDK message (declared or not). */
  const translate = (raw: unknown): readonly AgentEvent[] => {
    const message = rec(raw)
    const type = str(message?.type)
    if (message === undefined || type === undefined) return []
    // Subagent channel: projecting subagents into their panels is Phase 5;
    // their messages must not interleave with the main transcript.
    if (message.parent_tool_use_id !== undefined && message.parent_tool_use_id !== null && (type === 'assistant' || type === 'user' || type === 'stream_event')) return []
    switch (type) {
      case 'command_lifecycle':
        return translateLifecycle(message)
      case 'system':
        return translateSystem(message)
      case 'stream_event':
        return translateStream(message)
      case 'assistant':
        return translateAssistant(message)
      case 'user':
        return translateUser(message)
      case 'result':
        return translateResult(message)
      case 'tool_progress': {
        const callId = str(message.tool_use_id)
        if (callId === undefined || message.heartbeat === true) return []
        return [{ type: 'tool.progress', callId, elapsedMs: (num(message.elapsed_time_seconds) ?? 0) * 1000 }]
      }
      case 'rate_limit_event': {
        const info = rec(message.rate_limit_info)
        const windows = Object.entries(rec(info?.unifiedWindows) ?? {}).flatMap(([name, value]) => {
          const utilization = num(rec(value)?.utilization)
          return utilization === undefined ? [] : [{ name, utilization, ...(num(rec(value)?.resetsAt) === undefined ? {} : { resetsAt: num(rec(value)?.resetsAt) }) }]
        })
        return [{ type: 'rate-limit', info: { windows } }]
      }
      case 'conversation_reset':
        return [{ type: 'session.reset', trigger: str(message.trigger) ?? 'reset' }]
      default:
        debug(`claude: ${type} ignored`)
        return []
    }
  }

  return {
    translate,
    forceCloseTurn,
    /** A pushed input: its text becomes the user row once the CLI confirms
     *  it; a queued placement is a pending preview until then. */
    registerInput(uuid: string, text: string, placement: RegisteredInput['placement']): void {
      inputs.set(uuid, { text, placement })
      if (placement === 'steer' || placement === 'followup') pending.set(uuid, { id: uuid, text, placement })
      if (text.trim() === '/compact') compactRequested = true
    },
    /** Forget an input the session failed to push. */
    unregisterInput(uuid: string): void {
      inputs.delete(uuid)
      pending.delete(uuid)
    },
    /** Switch the user-row source once the CLI's capabilities are known. */
    setUserRows(mode: ClaudeUserRows): void {
      userRows = mode
    },
    get turnOpen(): boolean { return turnOpen },
  }
}

export type ClaudeTranslator = ReturnType<typeof createClaudeTranslator>
