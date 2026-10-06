/**
 * DSH to Agent Domain translator: decodes durable DSH `SessionEvent`s and
 * transient `agent/assistant-stream` frames into `AgentEvent`s for the shared
 * projector (`src/channel/projection.ts`). All DSH-specific knowledge the
 * projector needs lives here: message source kinds, compaction checkpoint
 * sources, the 0.1.7 tool result payload shape, goal payloads,
 * `request/header` model/effort, the optional todo/preset/colour/compaction
 * plugin events, subagent and `ask_user_question` tool names, `job_output`
 * reads and background-start acks, durable image attachments and the
 * dsh-tools presenters.
 *
 * State is kept small: the frame revision fence (transport-level dedupe) and
 * the open calls whose results still need a presenter. Attempt binding and
 * `seq` idempotency belong to the projector, so a projector reset (`/clear`)
 * does not depend on translator state.
 */
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, TurnEndReason as DshTurnEndReason } from '@deepseek-ai/dsh-session'
import { NO_EVENTS, type AgentEvent, type AgentEventOf, type AgentEventType, type GoalSnapshot, type TurnEndReason, type UsageDelta } from '../../agent/events.js'
import type { SuppressedToolPresentation, ToolCallPresentation, ToolResultPresentation } from '../../agent/presentation.js'
import type { PricingWindow } from '../../channel/usage.js'
import { isPeakHour } from '../../deepseekPricing.js'
import { BACKGROUND_START_ACK, isSubagentToolName, parseJobOutputId, todoPanelItems, toolCommandOf } from '../channel/projection-helpers.js'
import { harnessToolResultView, prepareReplayEvents, toolErrorText } from '../channel/transcript.js'
import type { ToolCallView, ToolResultView, ToolsRegistryLike } from '../channel/types.js'
import { isCompactionCheckpointSource, toolResultPayload } from '../compat/messages.js'
import { transcriptImagesOf } from '../transcript-images.js'

export interface DshTranslatorDeps {
  /** The host-plane tools registry (dsh-tools); absent in bare embedders,
   *  where every presenter call falls back to a plain text card. Read per
   *  presenter call (a session wrapper memoizes it). */
  tools(): ToolsRegistryLike | undefined
  /** Presenter scope: the live agent, so preset-owned tool definitions
   *  resolve (the dsh-host-apiproxy presenter pattern). Read per call. */
  scope(): unknown
  /** DSH attachment service, resolved at call time (a late-mounted provider
   *  must still serve images for rows projected earlier). */
  attachments(): unknown
}

/**
 * DeepSeek's rate windows, injected into the shared projector as its
 * `pricingWindow`: each usage buckets by the time its request ran.
 */
export function dshPricingWindow(time: number): PricingWindow {
  return isPeakHour(new Date(time)) ? 'peak' : 'idle'
}

/**
 * The DSH backend's decision for every Agent Domain event type: whether this
 * translator (or its session, for the bus-derived `session.status`,
 * `pending.changed` and `compaction.progress`) ever emits it. The exhaustive
 * switch is the point: a new `AgentEvent` variant fails `tsc` here until the
 * DSH side decides, and `verify:agent-domain` checks every translated fixture
 * event against it.
 */
export function dshEmits(type: AgentEventType): boolean {
  switch (type) {
    case 'session.title':
    case 'session.color':
    case 'session.status':
    case 'turn.start':
    case 'turn.end':
    case 'step.start':
    case 'step.end':
    case 'user.message':
    case 'pending.changed':
    case 'assistant.attempt.start':
    case 'assistant.delta':
    case 'assistant.attempt.end':
    case 'assistant.message':
    case 'tool.call':
    case 'tool.result':
    case 'task.start':
    case 'task.output':
    case 'compaction.start':
    case 'compaction.progress':
    case 'compaction.end':
    case 'context.capacity':
    case 'goal.change':
    case 'todo.write':
    case 'preset.selected':
    case 'system.prompt':
    case 'request.header':
    case 'custom':
      return true
    // Owned elsewhere on DSH (subagent/job extensions, approval and question
    // stores, model/mode actions) or not a DSH concept. Agent-to-agent relay
    // messages are folded by the adapter's subagent projection straight from
    // the durable session events, so the translator emits none.
    case 'agent.message':
    case 'session.ready':
    case 'session.reset':
    case 'tool.progress':
    // Optional, unused: DSH tool output reaches the card through the
    // settled result (and background jobs through task.output).
    case 'tool.output':
    case 'permission.request':
    case 'permission.settled':
    case 'question.request':
    case 'question.settled':
    case 'subagent.start':
    case 'subagent.progress':
    case 'subagent.end':
    case 'task.update':
    case 'task.end':
    case 'tasks.snapshot':
    case 'context.usage':
    case 'model.changed':
    case 'effort.changed':
    case 'mode.changed':
    case 'commands.changed':
    case 'notice':
    case 'rate-limit':
      return false
    default: {
      // Exhaustiveness: a new AgentEvent variant must be classified above.
      const unhandled: never = type
      return unhandled
    }
  }
}

/** Official presets recorded under a former name (blank-session preset
 *  markers show the user's current spelling, issue #8). A Map, not an object
 *  literal: the key is untrusted log data, and a plain-object lookup would
 *  resolve `constructor`/`toString`/… through `Object.prototype`. */
const PRESET_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ['code', ['ptc']],
  ['ptc', ['code']],
])

const QUESTION: SuppressedToolPresentation = { card: 'question' }
const SUBAGENT: SuppressedToolPresentation = { card: 'subagent' }
const OTHER_DELTA = { kind: 'other' } as const

/**
 * One durable goal mutation as the goal service records it (the `data` of a
 * top-level `goal/change` session event, and of the snapshot a round-zero
 * goal-sourced `user/message` may inline). Declared structurally: the pinned
 * peer's `SessionEvent` union predates the event type, so the fold admits the
 * payload by shape, not by union membership.
 */
type GoalChangePayload = {
  kind: 'goal/change'
  version: number
  operation:
    | 'create'
    | 'edit'
    | 'pause'
    | 'resume'
    | 'complete'
    | 'block'
    | 'clear'
  goal?: GoalSnapshot
  roundsStarted?: number
}

// ContentBlockMap is merge-extensible: plugin-added block types are silently
// skipped (v1 renders text blocks only) — never crashes.
const textOf = (content: readonly ContentBlock[] | undefined): string =>
  (content ?? []).map(block => (block.type === 'text' ? block.text : '')).join('').trim()

/**
 * Transcript-facing text of a user message: the first text block only.
 * `@`-mention attachments (issue #15) travel as later, model-facing blocks,
 * so joining every block would dump file contents into the bubble, the
 * sticky header and session titles.
 */
const firstTextOf = (content: readonly ContentBlock[] | undefined): string =>
  (content ?? []).find(block => block.type === 'text')?.text.trim() ?? ''

const goalChange = (change: GoalChangePayload): AgentEventOf<'goal.change'> => ({
  type: 'goal.change',
  operation: change.operation,
  goal: change.goal,
  roundsStarted: change.roundsStarted,
})

const usageDelta = (usage: TokenUsage | undefined): UsageDelta | undefined =>
  usage === undefined
    ? undefined
    : { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens }

/** DSH turn-close reasons; the ones without a shared name keep their label. */
const turnEndReason = (reason: DshTurnEndReason): TurnEndReason => {
  switch (reason.kind) {
    case 'completed':
    case 'aborted':
    case 'interrupted':
    case 'blocked':
      return { kind: reason.kind }
    case 'error':
      return { kind: 'error', message: reason.error.message }
    default:
      return { kind: 'other', label: reason.kind }
  }
}

type Delta = AgentEventOf<'assistant.delta'>['delta']
/** One stream chunk as a domain delta; non-content records stay `other`. */
const deltaOf = (chunk: StreamChunk): Delta => {
  switch (chunk.type) {
    case 'text-delta':
      return { kind: 'text', text: chunk.text }
    case 'reasoning-delta':
      return { kind: 'reasoning', text: chunk.text }
    case 'tool-call-delta':
      return { kind: 'tool-args', callId: chunk.id, partialJson: chunk.argumentsDelta, name: chunk.name }
    default:
      return OTHER_DELTA
  }
}

/** Create one translator; it serves exactly one session's event stream. */
export function createDshTranslator(deps: DshTranslatorDeps) {
  /** Frame revisions are monotone within one attached Agent lifecycle; a
   *  re-delivered or out-of-order frame is dropped here. */
  let lastStreamRevision = -1
  /**
   * Open calls by callId until their result: what the result's presenter,
   * images and task feeds need. `card: false` = question-presented (the
   * projector projects the record from the result text). Subagent calls are
   * not tracked: nothing about their result is projected. Bounded like the
   * projector's own card index: deleted on result, cleared on reset.
   */
  const openCalls = new Map<string, { readonly name: string; readonly args: string; readonly card: boolean }>()

  /** Ask the producing tool how its call should render (diff/terminal/…).
   *  Unknown tool, unparseable args, or a throwing presenter all degrade to
   *  the plain text card. */
  const presentCallView = (name: string, rawArgs: string): ToolCallView | undefined => {
    try {
      const tool = deps.tools()?.get(name, deps.scope())
      if (tool?.presentCall === undefined) return undefined
      return tool.presentCall(JSON.parse(rawArgs)) as ToolCallView | undefined
    } catch {
      return undefined
    }
  }
  /** Same for the settled result; `meta` is the tool-private presentation
   *  payload the tool attached to its tool/result event (dsh-tool-fs reads
   *  its result-time contextual diff back from here). */
  const presentResultView = (name: string, rawArgs: string, data: SessionEvent<'tool/result'>['data']): ToolResultView | undefined => {
    try {
      // Harness goal/todo tools first: their raw JSON is noise in the
      // transcript, so known shapes fold into a summary card before the
      // registry is asked (it may not know these tools).
      const local = harnessToolResultView(name, data)
      if (local !== undefined) return local
      const tool = deps.tools()?.get(name, deps.scope())
      if (tool?.presentResult === undefined) return undefined
      return tool.presentResult(JSON.parse(rawArgs), {
        ...toolResultPayload(data.message),
        ...(data.meta !== undefined ? { meta: data.meta } : {}),
      }) as ToolResultView | undefined
    } catch {
      return undefined
    }
  }

  const translateUserMessage = (event: SessionEvent<'user/message'>): readonly AgentEvent[] => {
    const data = event.data
    const base = { id: data.id, anchor: String(event.seq), seq: event.seq, time: event.time, blocks: data.content }
    // Both legacy and V4 checkpoints render as a folded summary rather than
    // disappearing with the other injected context.
    if (isCompactionCheckpointSource(data.source)) {
      return [{ type: 'user.message', ...base, source: 'compaction', text: textOf(data.content) }]
    }
    // Same-session goal domain: goal-sourced messages are the round driver's
    // continuation prompts (positive rounds advance the counter); some hosts
    // also inline the durable snapshot in a round-zero source. They are not
    // transcript bubbles — they drive the goal panel's projection (replayed on
    // resume/rewind like every other event; the snapshot itself arrives as
    // the top-level `goal/change` event).
    if ((data.source as { kind: string }).kind === 'goal') {
      const source = data.source as unknown as { round: number; change?: GoalChangePayload }
      if (source.round > 0) return [{ type: 'goal.change', operation: 'round', round: source.round }]
      const change = source.change
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may not match the static type
      if (change === undefined || change.kind !== 'goal/change') return NO_EVENTS
      return [goalChange(change)]
    }
    // Injected context (plugin/skill source) is model-facing only; it has no
    // transcript-facing text.
    if (data.source.kind !== 'user') return [{ type: 'user.message', ...base, source: 'injected', text: '' }]
    return [{
      type: 'user.message',
      ...base,
      source: 'user',
      text: firstTextOf(data.content),
      images: transcriptImagesOf(data.content, deps.attachments),
    }]
  }

  const translateToolResult = (event: SessionEvent<'tool/result'>): readonly AgentEvent[] => {
    const data = event.data
    const callId = data.message.source.callId
    const call = openCalls.get(callId)
    openCalls.delete(callId)
    const payload = toolResultPayload(data.message)
    const isError = data.error !== undefined || payload.isError
    // Text/presentation/images are derived only for results something
    // projects (a card or a question record).
    const text = call === undefined || isError ? '' : textOf(payload.content)
    const card = call?.card === true ? call : undefined
    const result: AgentEventOf<'tool.result'> = {
      type: 'tool.result',
      seq: event.seq,
      turn: data.turn,
      step: data.step,
      callId,
      isError,
      time: event.time,
      content: payload.content,
      text,
      ...(isError && call !== undefined ? { errorText: toolErrorText(event) } : {}),
      ...(card === undefined ? {} : { images: transcriptImagesOf(data.message.content, deps.attachments) }),
      ...(data.meta === undefined ? {} : { meta: data.meta }),
      ...(card === undefined || isError ? {} : { presentation: presentResultView(card.name, card.args, data) as ToolResultPresentation | undefined }),
    }
    if (card === undefined || isError) return [result]
    const events: AgentEvent[] = [result]
    // A job_output read doubles as the job card's output feed (the
    // registry's read is consuming and reserved for the owning agent).
    if (card.name === 'job_output' && text !== '') {
      const id = parseJobOutputId(card.args)
      if (id !== undefined) events.push({ type: 'task.output', taskId: id, text, time: event.time, callId })
    }
    // A `started background job <id>` ack pairs the job with its tool call.
    // Take the full command from the args; the registry label is only the
    // friendly description.
    const startAck = BACKGROUND_START_ACK.exec(text)
    if (startAck !== null) {
      const command = toolCommandOf(card.args)
      if (command !== undefined) {
        events.push({ type: 'task.start', taskId: startAck[1], kind: 'shell', description: '', command, callId, background: true, time: event.time })
      }
    }
    return events
  }

  /** Translate one durable session event (live or as part of a replay). */
  const translateEvent = (event: SessionEvent): readonly AgentEvent[] => {
    const type = (event as { type: string }).type
    // Top-level `goal/change` events are how the goal service records durable
    // goal mutations (create/edit/pause/resume/complete/block/clear) —
    // confirmed in production logs. The pinned peer's SessionEvent union
    // predates the type, so admit it structurally.
    if (type === 'goal/change') return [goalChange((event as unknown as { data: GoalChangePayload }).data)]
    switch (event.type) {
      case 'user/message':
        return translateUserMessage(event)
      case 'step/start':
        return [{ type: 'step.start', turn: event.data.turn, step: event.data.step }]
      case 'assistant/attempt':
        // A durable failed attempt, located by position (it has no stream id).
        return [{ type: 'assistant.attempt.end', attemptId: `seq:${event.seq}`, outcome: 'abandoned', turn: event.data.turn, step: event.data.step }]
      case 'assistant/message': {
        const data = event.data
        const content = data.message.content
        return [{
          type: 'assistant.message',
          seq: event.seq,
          anchor: String(event.seq),
          turn: data.turn,
          step: data.step,
          attemptId: `seq:${event.seq}`,
          time: event.time,
          blocks: content,
          images: transcriptImagesOf(content, deps.attachments),
          usage: usageDelta(data.usage),
          ...(data.interrupted === true ? { interrupted: true as const } : {}),
          // V3 embeds its complete attempt stream; older settlements may omit
          // reasoning that is still durably recorded in assistant/chunk events.
          canonical: Array.isArray((data as { stream?: unknown }).stream),
        }]
      }
      case 'tool/call': {
        const data = event.data
        const callId = data.callId
        const base = { type: 'tool.call' as const, seq: event.seq, anchor: String(event.seq), turn: data.turn, step: data.step, callId, name: data.name, argsJson: data.arguments, time: event.time }
        // ask_user_question renders as the interactive questionnaire panel
        // (DSH user-interaction seam), not as a tool card.
        if (data.name === 'ask_user_question') {
          openCalls.set(callId, { name: data.name, args: data.arguments, card: false })
          return [{ ...base, presentation: QUESTION }]
        }
        // The delegation tools render as the live subagent card.
        if (isSubagentToolName(data.name)) return [{ ...base, presentation: SUBAGENT }]
        openCalls.set(callId, { name: data.name, args: data.arguments, card: true })
        return [{ ...base, presentation: presentCallView(data.name, data.arguments) as ToolCallPresentation | undefined }]
      }
      case 'tool/result':
        return translateToolResult(event)
      case 'step/end':
        return [{ type: 'step.end', turn: event.data.turn, step: event.data.step }]
      case 'turn/start':
        return [{ type: 'turn.start', turn: event.data.turn, origin: 'user', time: event.time }]
      case 'turn/end':
        return [{ type: 'turn.end', turn: event.data.turn, reason: turnEndReason(event.data.reason), time: event.time }]
      case 'request/context':
        // Adapter-advertised context capacity, when the route reports one.
        return event.data.contextWindow === undefined ? NO_EVENTS : [{ type: 'context.capacity', contextWindow: event.data.contextWindow }]
      case 'system/message':
        // V3 system prompts are surface nodes, not header fields: the latest
        // node holds the active instructions (an empty render clears them).
        return [{ type: 'system.prompt', text: textOf(event.data.message.content) }]
      case 'request/header': {
        // The header carries the conversation's call config
        // (provider/model/effort/sampling). The system prompt moved out of
        // the header at V3 (see system/message); pre-V3 logs still carry it,
        // admitted structurally below.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable session data may lack header config
        const effort = event.data.header.config?.reasoningEffort
        const headerModel = (event.data.header.config as { model?: unknown } | undefined)?.model
        const header: AgentEvent = {
          type: 'request.header',
          // A missing/empty model must clear the previous header's value, or
          // later usage would keep billing the old model.
          model: typeof headerModel === 'string' && headerModel !== '' ? headerModel : undefined,
          effort: typeof effort === 'string' ? effort : undefined,
        }
        const legacySystem = (event.data.header as { system?: unknown }).system
        return typeof legacySystem === 'string' ? [header, { type: 'system.prompt', text: legacySystem }] : [header]
      }
      case 'session/title': {
        const source = (event.data as { source?: { kind?: unknown } }).source
        return [{ type: 'session.title', title: event.data.title, source: source?.kind === 'user' ? 'user' : 'auto' }]
      }
      default:
        break
    }
    const data = (event as { data?: unknown }).data
    switch (type) {
      case 'assistant/chunk': {
        // Pre-0.1.5 live streams and raw pre-V3 logs carry per-token chunks
        // as durable session events (0.1.5 moved live chunks to transient
        // frames and compacts the durable record into
        // `assistant/message.stream`). Matched by name so the current union
        // (which no longer lists the type) stays compile-clean.
        const chunk = data as { turn: number; step: number; chunk: StreamChunk }
        return [{
          type: 'assistant.delta',
          attemptId: `seq:${event.seq}`,
          index: (chunk.chunk as { index?: number }).index ?? 0,
          time: (event as { time: number }).time,
          turn: chunk.turn,
          step: chunk.step,
          seq: event.seq,
          delta: deltaOf(chunk.chunk),
        }]
      }
      case 'todo/write': {
        // dsh-tool-todo owns this optional module augmentation; matched by
        // name so the TUI remains loadable without that plugin.
        const todos = todoPanelItems(data)
        return todos === undefined ? NO_EVENTS : [{ type: 'todo.write', items: todos }]
      }
      case 'agent-preset/selected': {
        // Logged preset switch (blank sessions only, issue #8). Not in
        // dsh-session's typed union — matched by name.
        const recorded = (data as { agentPreset?: unknown }).agentPreset
        const preset = typeof recorded === 'string' ? recorded : 'unknown'
        const aliases = PRESET_ALIASES.get(preset)
        return [{ type: 'preset.selected', preset, ...(aliases === undefined ? {} : { aliases }) }]
      }
      case 'session/color': {
        // `/color` accent (dsh-tui plugin event): '' clears to the default.
        const color = (data as { color?: unknown }).color
        return [{ type: 'session.color', color: typeof color === 'string' ? color : '' }]
      }
      // The compaction bracket is a plugin-appended event pair (not part of
      // dsh-session's typed map): the host writes `compaction/start` before
      // the summarizer runs and `compaction/end` once the checkpoint is
      // committed or abandoned. The checkpoint `user/message` tells which,
      // so the close itself carries no outcome.
      case 'compaction/start':
        return [{ type: 'compaction.start', trigger: 'auto', cancellable: false, time: event.time }]
      case 'compaction/end':
        return [{ type: 'compaction.end', ok: true, time: event.time }]
      default:
        // Custom plugin events: the tuiRenderers seam decides whether they
        // render at all.
        return [{ type: 'custom', nativeType: type, data }]
    }
  }

  /**
   * Translate one live assistant stream frame (0.1.5+): the transient
   * per-token counterpart of the durable `assistant/message` /
   * `assistant/attempt` settlement.
   */
  const translateFrame = (frame: AssistantStreamFrame): readonly AgentEvent[] => {
    if (frame.revision <= lastStreamRevision) return NO_EVENTS
    lastStreamRevision = frame.revision
    const attemptId = frame.attemptId
    if (frame.type === 'start') return [{ type: 'assistant.attempt.start', attemptId, turn: frame.turn, step: frame.step }]
    if (frame.type === 'end') {
      // A settlement recorded as `assistant/attempt` is a failed attempt: its
      // provisional rows go, exactly like a live abandonment.
      const discarded = frame.outcome.kind === 'abandoned' || frame.outcome.eventType === 'assistant/attempt'
      return [{ type: 'assistant.attempt.end', attemptId, outcome: discarded ? 'abandoned' : 'committed' }]
    }
    return [{ type: 'assistant.delta', attemptId, index: frame.index, time: frame.time, delta: deltaOf(frame.chunk) }]
  }

  /**
   * Translate a durable replay seed (resume / rewind / model-switch fork).
   * Settled `assistant/chunk` runs are dropped first (`prepareReplayEvents`);
   * the frame fence restarts with the replacement session.
   */
  const translateReplay = (events: readonly SessionEvent[]): readonly AgentEvent[] => {
    lastStreamRevision = -1
    const out: AgentEvent[] = []
    for (const event of prepareReplayEvents(events)) {
      for (const translated of translateEvent(event)) out.push(translated)
    }
    return out
  }

  /** Forget the frame fence and every open call (paired with a projector reset). */
  const reset = (): void => {
    lastStreamRevision = -1
    openCalls.clear()
  }

  return { translateEvent, translateFrame, translateReplay, reset, presentCallView, presentResultView }
}

export type DshTranslator = ReturnType<typeof createDshTranslator>
