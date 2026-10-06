/**
 * Codex thread items → Agent Domain events: the one mapping live
 * notifications and history replay share (docs/codex-backend-design.md §7.1).
 * `live.ts` calls {@link itemEvents} on `item/started` / `item/completed`
 * and adds the stream deltas; `replay.ts` calls it with `started` then
 * `completed` for every item of every recorded turn. Any mapping lives here
 * once; `verify-codex-live-replay` keeps the two paths equal.
 *
 * Turns, steps and attempts (§7.2–§7.3):
 *  - a turn opens with its first item (a user message → a user turn, a
 *    `userShell` command → a user turn, anything else → a system turn) and
 *    closes with `turn/completed` (live) / the end of the recorded turn;
 *  - one model reply is one attempt (`<turnId>#<step>`) in its own step:
 *    reasoning, message and plan items open it, a message or plan completing
 *    settles it as one canonical `assistant.message`; a tool item settles a
 *    reasoning-only attempt and joins the current step;
 *  - a tool item still open when its turn closes was interrupted (an
 *    interrupted item never completes and never reaches history, F11).
 *
 * Identity: `user.message.id` is the client id the channel submitted (the
 * item id for another client's message); its `anchor` is the item id, the
 * native fork/rewind anchor, and each anchor maps to its turn id.
 */
import type { AgentEvent, AgentEventOf, ContentBlockView, TurnEndReason, UsageDelta } from '../../../agent/events.js'
import { t } from '../../../i18n.js'
import { arr, rec, str, type Rec } from '../narrow.js'
import { failureHint } from './notices.js'
import { TOOL_ITEM_TYPES, toolCallOf, toolResultOf, type ResultWords } from './presentation.js'
import { addUsage } from './usage.js'

/** The attempt (one model reply) being assembled. */
export interface OpenAttempt {
  readonly id: string
  readonly step: number
  reasoning: string
  text: string
  /** Reasoning streamed so far (a new summary part starts a paragraph). */
  streamedReasoning: string
  /** Text streamed so far: what an interrupted reply settles with when its
   *  item never completed. */
  streamedText: string
  /** Items whose raw reasoning stream is shown (no summary was streamed). */
  readonly rawReasoning: Set<string>
  /** Items whose summary streamed (their raw text stream stays hidden). */
  readonly summarized: Set<string>
  /** Usage reported while the attempt was open (attached at settle). */
  usage: UsageDelta | undefined
}

/** A tool item that started and has not completed. */
export interface OpenTool {
  readonly name: string
  readonly startedAt: number
}

export interface ItemContextOptions {
  readonly cwd: string
  readonly now?: () => number
  readonly debug?: (message: string) => void
  /** Where the numbering continues (a live translator after a replay). */
  readonly start?: { readonly turn: number; readonly seq: number }
  readonly model?: string
}

/** The translator state live and replay share (and hand over). */
export interface ItemContext {
  readonly cwd: string
  readonly debug: (message: string) => void
  now(): number
  nextSeq(): number
  readonly seq: number
  model: string
  turn: number
  turnOpen: boolean
  /** The native id of the open (or last) turn. */
  turnId: string
  step: number
  stepOpen: boolean
  attempt: OpenAttempt | undefined
  readonly openTools: Map<string, OpenTool>
  /** User-message anchor → native turn id (fork / rewind). */
  readonly anchorTurns: Map<string, string>
  /** A `/compact` this session asked for is running (manual trigger). */
  compactRequested: boolean
  /** A compaction item ran in the open turn. */
  compactionSeen: boolean
  /** Usage reported in the open turn (its `turn.end`). */
  turnUsage: UsageDelta | undefined
  readonly words: ResultWords
}

/** Anchors remembered (one per user message; the oldest go first). */
const MAX_ANCHORS = 4000

/** A `!!cmd` output the channel sends on to the model. */
const BASH_OUTPUT = /^<bash-stdout>\n?([\s\S]*?)\n?<\/bash-stdout>$/u

export function createItemContext(options: ItemContextOptions): ItemContext {
  let seq = options.start?.seq ?? 0
  const clock = options.now ?? Date.now
  return {
    cwd: options.cwd,
    debug: options.debug ?? (() => undefined),
    now: () => clock(),
    nextSeq: () => ++seq,
    get seq() { return seq },
    model: options.model ?? '',
    turn: options.start?.turn ?? 0,
    turnOpen: false,
    turnId: '',
    step: 0,
    stepOpen: false,
    attempt: undefined,
    openTools: new Map(),
    anchorTurns: new Map(),
    compactRequested: false,
    compactionSeen: false,
    turnUsage: undefined,
    words: { declined: t('codex-declined'), failed: t('codex-tool-failed') },
  }
}

/** Open a turn (no-op when one is open). */
export function openTurn(ctx: ItemContext, out: AgentEvent[], origin: AgentEventOf<'turn.start'>['origin'], time: number, userMessageId?: string): void {
  if (ctx.turnOpen) return
  ctx.turnOpen = true
  ctx.turn += 1
  ctx.step = 0
  ctx.stepOpen = false
  ctx.turnUsage = undefined
  ctx.compactionSeen = false
  out.push({ type: 'turn.start', turn: ctx.turn, origin, time, ...(userMessageId === undefined ? {} : { userMessageId }) })
}

export function closeStep(ctx: ItemContext, out: AgentEvent[]): void {
  if (!ctx.stepOpen) return
  ctx.stepOpen = false
  out.push({ type: 'step.end', turn: ctx.turn, step: ctx.step })
}

/** A step for a tool that no reply opened (a turn's first item is a tool). */
export function ensureStep(ctx: ItemContext, out: AgentEvent[]): void {
  if (ctx.stepOpen) return
  ctx.step += 1
  ctx.stepOpen = true
  out.push({ type: 'step.start', turn: ctx.turn, step: ctx.step })
}

/** The open attempt, or a new one in a new step. */
export function ensureAttempt(ctx: ItemContext, out: AgentEvent[]): OpenAttempt {
  if (ctx.attempt !== undefined) return ctx.attempt
  closeStep(ctx, out)
  ctx.step += 1
  ctx.stepOpen = true
  out.push({ type: 'step.start', turn: ctx.turn, step: ctx.step })
  const id = `${ctx.turnId === '' ? `turn-${ctx.turn}` : ctx.turnId}#${ctx.step}`
  out.push({ type: 'assistant.attempt.start', attemptId: id, turn: ctx.turn, step: ctx.step, ...(ctx.model === '' ? {} : { model: ctx.model }) })
  ctx.attempt = { id, step: ctx.step, reasoning: '', text: '', streamedReasoning: '', streamedText: '', rawReasoning: new Set(), summarized: new Set(), usage: undefined }
  return ctx.attempt
}

/** Settle the open attempt as one canonical assistant message. */
export function settleAttempt(ctx: ItemContext, out: AgentEvent[], time: number, interrupted = false): void {
  const open = ctx.attempt
  if (open === undefined) return
  ctx.attempt = undefined
  // A completed item's text is the record; a reply cut short keeps what
  // streamed (an interrupted item never completes, F11).
  const reasoning = open.reasoning !== '' ? open.reasoning : open.streamedReasoning
  const replyText = open.text !== '' ? open.text : open.streamedText
  const blocks: ContentBlockView[] = []
  if (reasoning !== '') blocks.push({ type: 'reasoning', text: reasoning })
  if (replyText !== '') blocks.push({ type: 'text', text: replyText })
  out.push({
    type: 'assistant.message',
    seq: ctx.nextSeq(),
    anchor: open.id,
    turn: ctx.turn,
    step: open.step,
    attemptId: open.id,
    time,
    ...(ctx.model === '' ? {} : { model: ctx.model }),
    blocks,
    ...(open.usage === undefined ? {} : { usage: open.usage }),
    ...(interrupted ? { interrupted: true as const } : {}),
    canonical: true,
  })
}

/**
 * Close the open turn: settle the reply, end the still-open tools as
 * interrupted, close the step, `turn.end`, then the failure's hint. A turn
 * that produced no item opens first (a turn that failed at once).
 */
export function closeTurn(ctx: ItemContext, out: AgentEvent[], reason: TurnEndReason, time: number): void {
  if (!ctx.turnOpen) openTurn(ctx, out, 'system', time)
  const interrupted = reason.kind === 'interrupted' || reason.kind === 'aborted'
  settleAttempt(ctx, out, time, interrupted)
  for (const [callId] of ctx.openTools) {
    out.push({ type: 'tool.result', seq: ctx.nextSeq(), turn: ctx.turn, step: ctx.step, callId, isError: true, time, content: [], text: '', errorText: interrupted ? t('codex-interrupted') : t('codex-tool-unfinished') })
  }
  ctx.openTools.clear()
  closeStep(ctx, out)
  ctx.turnOpen = false
  out.push({ type: 'turn.end', turn: ctx.turn, reason, time, ...(ctx.turnUsage === undefined ? {} : { usage: ctx.turnUsage }) })
  ctx.turnUsage = undefined
  ctx.compactRequested = false
  const hint = failureHint(reason)
  if (hint !== undefined) out.push(hint)
}

/** Usage of one model call: attached to the open reply when there is one,
 *  else reported for the current step on a usage-only message. */
export function reportUsage(ctx: ItemContext, out: AgentEvent[], usage: UsageDelta, time: number): void {
  ctx.turnUsage = addUsage(ctx.turnUsage, usage)
  if (ctx.attempt !== undefined) {
    ctx.attempt.usage = addUsage(ctx.attempt.usage, usage)
    return
  }
  if (!ctx.turnOpen) return
  const step = Math.max(1, ctx.step)
  // No blocks and not canonical: the projector books the usage (tokens,
  // the turn's summary, the context sample) and leaves every row as it is.
  out.push({ type: 'assistant.message', seq: ctx.nextSeq(), anchor: '', turn: ctx.turn, step, attemptId: `${ctx.turnId}#${step}#usage`, time, blocks: [], usage, canonical: false })
}

/** The user-facing text and the model-facing blocks of a user message. */
function userContent(content: unknown): { readonly text: string; readonly blocks: readonly ContentBlockView[] } {
  const blocks: ContentBlockView[] = []
  const texts: string[] = []
  const references: string[] = []
  for (const raw of arr(content)) {
    const input = rec(raw)
    const type = str(input?.type)
    if (input === undefined || type === undefined) continue
    switch (type) {
      case 'text': {
        const value = str(input.text) ?? ''
        texts.push(value)
        blocks.push({ type: 'text', text: value })
        break
      }
      case 'mention':
        references.push(`@${str(input.path) ?? str(input.name) ?? ''}`)
        blocks.push({ type: 'mention' })
        break
      case 'skill':
        references.push(`$${str(input.name) ?? ''}`)
        blocks.push({ type: 'skill' })
        break
      default:
        blocks.push({ type })
        break
    }
  }
  // The first text input is what the user typed; later ones are what the
  // channel attached (expanded mentions, selections).
  return { text: texts[0] ?? references.join(' '), blocks }
}

/** The origin a turn's first item gives it. */
function originOf(item: Rec): AgentEventOf<'turn.start'>['origin'] {
  const type = str(item.type)
  if (type === 'userMessage') return 'user'
  if (type === 'commandExecution' && str(item.source) === 'userShell') return 'user'
  return 'system'
}

/** Forget the oldest anchors beyond the bound. */
function rememberAnchor(ctx: ItemContext, anchor: string): void {
  ctx.anchorTurns.set(anchor, ctx.turnId)
  if (ctx.anchorTurns.size > MAX_ANCHORS) ctx.anchorTurns.delete(ctx.anchorTurns.keys().next().value!)
}

/** One item's events for one phase (see the module comment). */
export function itemEvents(item: Rec, phase: 'started' | 'completed', ctx: ItemContext, time: number): AgentEvent[] {
  const out: AgentEvent[] = []
  const type = str(item.type)
  const id = str(item.id) ?? ''
  if (type === undefined) return out
  if (!ctx.turnOpen) {
    const clientId = type === 'userMessage' ? str(item.clientId) : undefined
    openTurn(ctx, out, originOf(item), time, type === 'userMessage' ? (clientId ?? id) : undefined)
  }
  switch (type) {
    case 'userMessage': {
      if (phase !== 'started') return out
      const { text, blocks } = userContent(item.content)
      const clientId = str(item.clientId)
      rememberAnchor(ctx, id)
      const output = BASH_OUTPUT.exec(text)
      out.push({
        type: 'user.message',
        id: clientId ?? id,
        anchor: id,
        seq: ctx.nextSeq(),
        turn: ctx.turn,
        time,
        source: output === null ? 'user' : 'command-output',
        text: output === null ? text : output[1]!.trim(),
        blocks,
      })
      return out
    }
    case 'hookPrompt': {
      if (phase !== 'started') return out
      const text = arr(item.fragments).map(fragment => str(rec(fragment)?.text) ?? '').join('\n')
      out.push({ type: 'user.message', id, anchor: id, seq: ctx.nextSeq(), turn: ctx.turn, time, source: 'injected', label: 'hook', text, blocks: [{ type: 'text', text }] })
      return out
    }
    case 'reasoning': {
      const attempt = ensureAttempt(ctx, out)
      if (phase === 'completed') {
        const summary = arr(item.summary).filter((part): part is string => typeof part === 'string')
        const content = arr(item.content).filter((part): part is string => typeof part === 'string')
        const reasoning = (summary.length > 0 ? summary : content).join('\n\n')
        if (reasoning !== '') attempt.reasoning = attempt.reasoning === '' ? reasoning : `${attempt.reasoning}\n\n${reasoning}`
      }
      return out
    }
    case 'agentMessage':
    case 'plan': {
      const attempt = ensureAttempt(ctx, out)
      if (phase === 'completed') {
        attempt.text = str(item.text) ?? ''
        settleAttempt(ctx, out, time)
      }
      return out
    }
    case 'contextCompaction': {
      settleAttempt(ctx, out, time)
      if (phase === 'started') {
        ctx.compactionSeen = true
        out.push({ type: 'compaction.start', trigger: ctx.compactRequested ? 'manual' : 'auto', cancellable: false, time })
      } else {
        out.push({ type: 'compaction.end', ok: true, time })
      }
      return out
    }
    case 'enteredReviewMode': {
      if (phase !== 'started') return out
      settleAttempt(ctx, out, time)
      out.push({ type: 'notice', level: 'info', key: `review:${id}`, text: t('codex-review-start', { review: str(item.review) ?? '' }) })
      return out
    }
    case 'exitedReviewMode': {
      if (phase !== 'completed') return out
      settleAttempt(ctx, out, time)
      const attempt = ensureAttempt(ctx, out)
      attempt.text = str(item.review) ?? ''
      settleAttempt(ctx, out, time)
      return out
    }
    default:
      break
  }
  if (TOOL_ITEM_TYPES.has(type)) {
    const startCall = (): void => {
      settleAttempt(ctx, out, time)
      ensureStep(ctx, out)
      const call = toolCallOf(item, ctx.cwd)
      if (call === undefined) return
      ctx.openTools.set(id, { name: call.name, startedAt: time })
      out.push({ type: 'tool.call', seq: ctx.nextSeq(), turn: ctx.turn, step: ctx.step, callId: id, name: call.name, argsJson: call.argsJson, ...(call.presentation === undefined ? {} : { presentation: call.presentation }), time })
    }
    if (phase === 'started') {
      if (!ctx.openTools.has(id)) startCall()
      return out
    }
    // A completion whose start was never seen still gets its call first.
    if (!ctx.openTools.has(id)) startCall()
    ctx.openTools.delete(id)
    const result = toolResultOf(item, ctx.cwd, ctx.words)
    out.push({
      type: 'tool.result',
      seq: ctx.nextSeq(),
      turn: ctx.turn,
      step: ctx.step,
      callId: id,
      isError: result.isError,
      time,
      content: result.content,
      text: result.text,
      ...(result.errorText === undefined ? {} : { errorText: result.errorText }),
      ...(result.structured === undefined ? {} : { structured: result.structured }),
      ...(result.presentation === undefined ? {} : { presentation: result.presentation }),
    })
    return out
  }
  // An item type this backend does not render: the plugin renderer seam
  // (a registered renderer may show it; by default nothing does).
  if (phase === 'completed') {
    ctx.debug(`codex: no mapping for item type ${type}`)
    out.push({ type: 'custom', nativeType: `codex/${type}`, data: item })
  }
  return out
}
