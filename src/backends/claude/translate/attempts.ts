/** Assemble turns, attempts and streaming deltas into canonical messages. */
import type { AgentEvent, AgentEventOf, ContentBlockView, TurnEndReason, UsageDelta } from '../../../agent/events.js'
import { claudeText } from '../text.js'
import { arr, num, rec, str, type Rec } from '../narrow.js'
import { narrationOf, usageOf } from './content.js'
import type { OpenAttempt } from './types.js'

/** Abort diagnostics the CLI appends to `result.errors` (never shown). */
const EDE_DIAGNOSTIC = '[ede_diagnostic]'
/** Settled API message ids remembered (a late block only ever trails the
 *  response it belongs to by a few messages). */
export const MAX_SETTLED_ATTEMPTS = 256

export function createAttemptTranslator(context: {
  stepOpen: boolean
  step: number
  turn: number
  turnOpen: boolean
  turnTime: number
  toolResults: number
  narrated: string | undefined
  notificationTurnExpected: boolean
  currentModel: string
  attempt: OpenAttempt | undefined
  compactRequested: boolean
  readonly settledAttempts: Set<string>
  now(): number
  nextSeq(): number
}) {
  const { settledAttempts, now, nextSeq } = context
  const closeStep = (out: AgentEvent[]): void => {
    if (!context.stepOpen) return
    context.stepOpen = false
    out.push({ type: 'step.end', turn: context.turn, step: context.step })
  }

  const openTurn = (out: AgentEvent[], origin: AgentEventOf<'turn.start'>['origin'], userMessageId?: string): void => {
    if (context.turnOpen) return
    context.turnOpen = true
    context.turn += 1
    context.step = 0
    context.turnTime = now()
    context.toolResults = 0
    context.narrated = undefined
    // An unprompted turn right after a task notification is the model
    // reporting on it: a notice stands where a user bubble would be.
    const notified = origin === 'system' && context.notificationTurnExpected
    context.notificationTurnExpected = false
    out.push({ type: 'turn.start', turn: context.turn, origin: notified ? 'notification' : origin, time: now(), ...(userMessageId === undefined ? {} : { userMessageId }) })
    if (notified) out.push({ type: 'notice', level: 'info', text: claudeText('claude-notification-turn') })
  }

  /** Settle the open attempt as one canonical assistant message. */
  const settleAttempt = (out: AgentEvent[]): void => {
    const open = context.attempt
    if (open === undefined) return
    context.attempt = undefined
    settledAttempts.add(open.id)
    if (settledAttempts.size > MAX_SETTLED_ATTEMPTS) settledAttempts.delete(settledAttempts.values().next().value!)
    // A reply that narrated keeps the working line narrating until the turn
    // ends (the fold's freshness window is the turn itself). A streamed
    // response never re-delivers its blocks; the settled message carries them.
    const complete = narrationOf(open.streamText !== '' ? open.streamText : open.text)
    if (complete !== undefined) context.narrated = complete
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
      turn: context.turn,
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
    if (context.attempt?.id === id) return context.attempt
    if (settledAttempts.has(id)) return undefined
    settleAttempt(out)
    openTurn(out, 'system')
    closeStep(out)
    context.step += 1
    context.stepOpen = true
    out.push({ type: 'step.start', turn: context.turn, step: context.step })
    out.push({ type: 'assistant.attempt.start', attemptId: id, turn: context.turn, step: context.step, ...(model === undefined ? {} : { model }) })
    // `message_start.model` is the CLI's own confirmation of the model a
    // request ran on: an in-place switch shows up here first.
    if (model !== undefined && model !== '' && context.currentModel !== '' && model !== context.currentModel) {
      context.currentModel = model
      out.push({ type: 'model.changed', model, source: 'settings' })
    }
    context.attempt = { id, step: context.step, model, reasoning: '', text: '', streamText: '', blocks: 0, aborted: false, usage, outputTokens: undefined, streamTools: new Map() }
    return context.attempt
  }

  const delta = (open: OpenAttempt, value: AgentEventOf<'assistant.delta'>['delta'], index: number): AgentEvent =>
    ({ type: 'assistant.delta', attemptId: open.id, index, time: now(), delta: value })

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
        const open = context.attempt
        if (open === undefined || block?.type !== 'tool_use') return out
        const callId = str(block.id)
        const name = str(block.name)
        if (callId === undefined) return out
        open.streamTools.set(index, callId)
        out.push(delta(open, { kind: 'tool-args', callId, partialJson: '', ...(name === undefined ? {} : { name }) }, index))
        return out
      }
      case 'content_block_delta': {
        const open = context.attempt
        const body = rec(event.delta)
        const index = num(event.index) ?? 0
        if (open === undefined || body === undefined) return out
        switch (str(body.type)) {
          case 'text_delta': {
            const text = str(body.text) ?? ''
            if (text !== '') {
              open.streamText += text
              out.push(delta(open, { kind: 'text', text }, index))
            }
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
        const open = context.attempt
        // `message_start` 的 usage 是占位零值；本请求的真实计数（含 input
        // 与 cache split——上下文读数与 cache N 都靠它们）只在 message_delta
        // 与 result 上到达，这里全量覆盖。
        const deltaUsage = usageOf(event.usage)
        const output = num(rec(event.usage)?.output_tokens)
        if (open !== undefined) {
          if (deltaUsage !== undefined) open.usage = deltaUsage
          if (output !== undefined) open.outputTokens = output
        }
        return out
      }
      case 'message_stop':
        settleAttempt(out)
        return out
      default:
        return out
    }
  }

  /** `result`: the authoritative turn close. */
  const translateResult = (message: Rec): AgentEvent[] => {
    const out: AgentEvent[] = []
    // `result.usage` 是本轮的权威计数（assistant 消息体上的 usage 是占位
    // 零值，真值只随流式 message_delta 与 result 到达）——settle 前并进还
    // 开着的 attempt，无细流的 CLI 也能让 lastUsage / cache 读数落位。
    const authoritative = usageOf(message.usage)
    if (authoritative !== undefined && context.attempt !== undefined) context.attempt.usage = authoritative
    settleAttempt(out)
    closeStep(out)
    const subtype = str(message.subtype)
    const terminal = str(message.terminal_reason)
    const isError = message.is_error === true
    // A `now`-interrupted turn is `subtype:'success'` with
    // `terminal_reason:'aborted_*'`: the terminal reason decides first.
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
    if (context.turnOpen) {
      context.turnOpen = false
      out.push({
        type: 'turn.end',
        turn: context.turn,
        reason,
        time: now(),
        ...(cost === undefined ? {} : { cost: { currency: 'USD', amount: cost, source: 'backend' as const } }),
      })
    }
    context.compactRequested = false
    return out
  }

  /** Close an open turn without a `result` (idle backstop, forced settle,
   *  process death). */
  function forceCloseTurn(reason: TurnEndReason): AgentEvent[] {
    const out: AgentEvent[] = []
    settleAttempt(out)
    closeStep(out)
    if (context.turnOpen) {
      context.turnOpen = false
      out.push({ type: 'turn.end', turn: context.turn, reason, time: now() })
    }
    return out
  }
  return { closeStep, openTurn, settleAttempt, ensureAttempt, delta, translateStream, translateResult, forceCloseTurn }
}
