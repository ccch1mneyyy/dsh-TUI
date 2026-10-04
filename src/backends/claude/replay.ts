/**
 * Claude session transcript → Agent Domain replay (docs/agent-backend-design.md
 * §4.11, the replay column of §5.1): the durable history a resumed session
 * paints before it follows live events.
 *
 * Input is what the SDK's read API returns — `getSessionMessages(id,
 * {includeSystemMessages:true})`, the model-visible chain (after a
 * compaction: the boundary, the summary, the preserved tail and what came
 * later) — plus each subagent's `getSubagentMessages`. Output is the same
 * vocabulary the live translator emits, produced by the SAME translator
 * (`translate.ts`): assistant blocks, tool calls and results, plan / todo /
 * question tools and the compaction rows map exactly as they do live. Only
 * the turn segmentation is replay's own, because the transcript has no
 * lifecycle frames and no `result`s:
 *
 * - a real user prompt closes the open turn and opens a user turn (its row
 *   anchored at the message uuid — the `uuid` the session pushed, which the
 *   CLI keeps, so live and replayed rows rewind the same way);
 * - a queued prompt (`isQueuedCommand`, a steer folded into a running turn)
 *   joins the open turn, as its `started` frame does live;
 * - `[Request interrupted by user]` closes the turn as aborted (the live
 *   interrupt row); a `task-notification` prompt opens the notification
 *   turn; local-command echoes (`<command-name>`, `<local-command-*>`), meta
 *   and synthetic texts never become bubbles — a user-typed slash command
 *   shows as the `/name args` it was typed as (`/compact` excepted, as
 *   live); command output sent on to the model (`<bash-stdout>`, dsh-tui's
 *   `!!`) is a prompt of its own: it closes the open turn and opens the
 *   turn the model answers it in, shown as its output row (as live);
 * - a compact summary (`isCompactSummary`) closes the open turn and renders
 *   the compaction rows (`compaction.end` + the summary).
 *
 * Thinking: the CLI records thinking blocks with empty text (the API only
 * returns signatures unless summaries are enabled). A step whose API message
 * reports `output_tokens_details.thinking_tokens` replays the same one-line
 * count row the live `thinking_tokens` estimate produces; an empty block
 * without a count is not shown (as live: nothing to show).
 *
 * Subagents: the parent `Agent` call pre-creates its subagent (as live);
 * when the session kept the subagent's transcript, a `subagent.start` with
 * the subagent's own id completes it, followed by its messages as child-lane
 * events (`parentCallId` = the call) — its card and panels, never the main
 * transcript. Its `subagent.end` comes from what the main chain recorded:
 * the call's result for a foreground subagent (the hand-back report, an
 * error, an interruption), the `<task-notification>` naming it for a
 * background one (whose result only acknowledges the launch); with neither,
 * its state is `unknown` (the CLI that ran it is gone). A subagent's own
 * delegations (nested `Agent` calls in its transcript) are tracked the same
 * way: ended by the result in that transcript, else `unknown` at the end of
 * the replay.
 *
 * Not restored from the transcript: the context window (the read API has no
 * field for it; the first live `result` reports it) and the session cost (the
 * resumed CLI's first `result` reports it, as for any session).
 *
 * Pure: no I/O, no clock (event times come from the message timestamps).
 */
import type { AgentEvent, SubagentUsage } from '../../agent/events.js'
import { transcriptImages } from './images.js'
import { arr, num, rec, str, type Rec } from './narrow.js'
import { COMMAND_TAG, createClaudeTranslator, INTERRUPT_ECHO, LOCAL_COMMAND_TAG, userText, type ClaudeTaskSeed } from './translate.js'

/** The tool names the CLI uses for a subagent launch (current, legacy). */
const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])

const BASH_OUTPUT_TAG = /^<bash-(stdout|stderr)>/u
const BASH_INPUT = /^<bash-input>([\s\S]*?)<\/bash-input>/u
const TASK_NOTIFICATION = /^<task-notification>/u
/** A background subagent's launch acknowledgement (not its end). */
const ASYNC_LAUNCH = /^Async agent launched/u
/** Nested subagent transcripts followed at most this deep (a corrupted
 *  store cannot recurse without bound). */
const MAX_NESTING = 8

/** One subagent transcript, keyed by the `Agent` tool call that launched
 *  it (and, for healing, by the child's own agent id). */
export interface ClaudeSubagentTranscript {
  readonly agentId: string
  readonly messages: readonly unknown[]
  /** `parent_agent_id` of the child's messages (sdk.d.ts:6437-6449): the
   *  agent that spawned it. Absent/null = a depth-1 child (spawned by the
   *  main loop) or old-format metadata that never recorded it — never an
   *  orphan: such a transcript heals onto a delegation by agent id. */
  readonly parentAgentId?: string
}

export interface ClaudeReplayOptions {
  readonly cwd: string
  /** Subagent transcripts by parent `tool_use_id`. */
  readonly subagents?: ReadonlyMap<string, ClaudeSubagentTranscript>
  /** The session's title (custom or generated), when the catalog has one. */
  readonly title?: string
  readonly debug?: (message: string) => void
}

export interface ClaudeReplay {
  readonly events: readonly AgentEvent[]
  /** The counters (and model) the live translator of the resumed session
   *  continues from. */
  readonly start: { readonly turn: number; readonly seq: number; readonly model?: string }
  /** The replayed conversation's task table (the Task* family), handed to
   *  the live translator so a resumed update finds the ids the replay
   *  tracked (R2 review). Absent when the history tracked none. */
  readonly tasks?: readonly ClaudeTaskSeed[]
  /**
   * The chain began at a compaction (its boundary's uuid, or the summary's
   * when no boundary entry led it): older history exists on disk.
   */
  readonly compactedFrom?: string
}

/** `/name args` of a recorded slash-command echo. */
function commandLine(text: string): string | undefined {
  const name = /<command-name>([\s\S]*?)<\/command-name>/u.exec(text)?.[1]?.trim()
  if (name === undefined || name === '') return undefined
  const args = /<command-args>([\s\S]*?)<\/command-args>/u.exec(text)?.[1]?.trim() ?? ''
  const slash = name.startsWith('/') ? name : `/${name}`
  return args === '' ? slash : `${slash} ${args}`
}

/** What one user message of the chain is. */
type UserKind =
  | { readonly kind: 'results' }
  | { readonly kind: 'summary'; readonly text: string }
  | { readonly kind: 'prompt'; readonly text: string; readonly queued: boolean }
  | { readonly kind: 'interrupt' }
  | { readonly kind: 'notification' }
  | { readonly kind: 'hidden'; readonly why: string }

function classifyUser(message: Rec): UserKind {
  const content = rec(message.message)?.content
  if (arr(content).some(block => rec(block)?.type === 'tool_result')) return { kind: 'results' }
  const raw = userText(content) ?? ''
  const text = raw.trim()
  if (message.isCompactSummary === true) return { kind: 'summary', text }
  if (message.is_meta === true || message.isMeta === true) return { kind: 'hidden', why: 'meta' }
  // An image-only prompt is a prompt (its row shows the images).
  if (text === '' && arr(content).some(block => rec(block)?.type === 'image')) return { kind: 'prompt', text: '', queued: message.isQueuedCommand === true }
  if (text === '') return { kind: 'hidden', why: 'empty' }
  if (text.startsWith(INTERRUPT_ECHO)) return { kind: 'interrupt' }
  const origin = str(rec(message.origin)?.kind)
  if ((origin !== undefined && origin !== 'human') || TASK_NOTIFICATION.test(text)) return { kind: 'notification' }
  if (LOCAL_COMMAND_TAG.test(text)) return { kind: 'hidden', why: 'local output' }
  // Command output sent on to the model: its own turn (the translator shows
  // it as its output row, never a bubble).
  if (BASH_OUTPUT_TAG.test(text)) return { kind: 'prompt', text: raw, queued: false }
  if (COMMAND_TAG.test(text)) {
    const line = commandLine(text)
    // `/compact` never shows its own row (live hides it too); its summary
    // is the compaction's row.
    if (line === undefined || line === '/compact' || line.startsWith('/compact ')) return { kind: 'hidden', why: 'command echo' }
    return { kind: 'prompt', text: line, queued: message.isQueuedCommand === true }
  }
  const bash = BASH_INPUT.exec(text)
  if (bash !== null) return { kind: 'prompt', text: `!${bash[1]!.trim()}`, queued: false }
  return { kind: 'prompt', text: raw, queued: message.isQueuedCommand === true }
}

type SubagentOutcome = { readonly status: 'completed' | 'failed' | 'cancelled' | 'unknown'; readonly summary?: string; readonly usage?: SubagentUsage }

/** The report inside a foreground subagent's hand-back result (the frame
 *  stripped, the indentation removed). */
function handBackReport(text: string): string {
  const marker = text.indexOf('The report follows:')
  let body = marker === -1 ? text : text.slice(marker + 'The report follows:'.length)
  body = body.replace(/\n?agentId: [\s\S]*$/u, '').replace(/<usage>[\s\S]*?<\/usage>/gu, '')
  return body.split('\n').map(line => line.replace(/^ {2}/u, '')).join('\n').trim()
}

/** `<usage>subagent_tokens: N …</usage>` of a hand-back result. */
function handBackUsage(text: string): SubagentUsage | undefined {
  const usage = /<usage>([\s\S]*?)<\/usage>/u.exec(text)?.[1]
  if (usage === undefined) return undefined
  const field = (name: string): number | undefined => {
    const value = Number(new RegExp(`${name}:\\s*(\\d+)`, 'u').exec(usage)?.[1])
    return Number.isFinite(value) ? value : undefined
  }
  const total = field('subagent_tokens') ?? field('total_tokens')
  const toolUses = field('tool_uses')
  const durationMs = field('duration_ms')
  return total === undefined && toolUses === undefined ? undefined : { ...(total === undefined ? {} : { total }), ...(toolUses === undefined ? {} : { toolUses }), ...(durationMs === undefined ? {} : { durationMs }) }
}

/** What a foreground subagent's recorded result says about its end. */
function resultOutcome(block: Rec): SubagentOutcome {
  const text = userText(block.content) ?? (typeof block.content === 'string' ? block.content : '')
  if (block.is_error === true) return { status: 'failed', ...(text === '' ? {} : { summary: text }) }
  if (text.startsWith(INTERRUPT_ECHO)) return { status: 'cancelled' }
  const usage = handBackUsage(text)
  const summary = handBackReport(text)
  return { status: 'completed', ...(summary === '' ? {} : { summary }), ...(usage === undefined ? {} : { usage }) }
}

/** A `<task-notification>` prompt's fields. */
function notificationOf(text: string): { readonly taskId?: string; readonly callId?: string; readonly status?: string; readonly summary?: string } {
  const tag = (name: string): string | undefined => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'u').exec(text)?.[1]?.trim()
  const taskId = tag('task-id')
  const callId = tag('tool-use-id')
  const status = tag('status')
  const summary = tag('summary') ?? tag('result')
  return { ...(taskId === undefined ? {} : { taskId }), ...(callId === undefined ? {} : { callId }), ...(status === undefined ? {} : { status }), ...(summary === undefined ? {} : { summary }) }
}

/** Replay one transcript chain. */
export function replayClaudeTranscript(messages: readonly unknown[], options: ClaudeReplayOptions): ClaudeReplay {
  const debug = options.debug ?? (() => undefined)
  let clock = 0
  const translator = createClaudeTranslator({ cwd: options.cwd, userRows: 'lifecycle', now: () => clock, debug })
  const out: AgentEvent[] = []
  /** The open turn saw `[Request interrupted …]`: it closes as aborted. */
  let interrupted = false
  let model: string | undefined
  /** API message ids whose thinking count was already replayed. */
  const counted = new Set<string>()
  /** Subagents launched by a call whose end has not been replayed yet. */
  const launched = new Map<string, { readonly agentId: string; background: boolean }>()
  /** Subagent transcripts already attached to a delegation (a healed child
   *  must not attach twice; the same transcript is reachable under both its
   *  delegating call id and its own agent id). */
  const claimed = new Set<string>()

  /** Every transcript once, by its own agent id (the map also keys them by
   *  their delegating call). */
  const uniqueTranscripts: ClaudeSubagentTranscript[] = []
  for (const transcript of options.subagents?.values() ?? []) {
    if (uniqueTranscripts.some(seen => seen.agentId === transcript.agentId)) continue
    uniqueTranscripts.push(transcript)
  }
  /** Recorded hand-back results name the child they return (`agentId: <id>` —
   *  the same line handBackReport strips): an exact, falsifiable attribution
   *  channel for a child whose own metadata never recorded the call id. */
  const childOfResult = new Map<string, string>()
  const indexHandBackIds = (source: readonly unknown[]): void => {
    for (const raw of source) {
      const message = rec(raw)
      if (message === undefined || message.type !== 'user') continue
      for (const block of arr(rec(message.message)?.content).map(rec)) {
        if (block?.type !== 'tool_result') continue
        const callId = str(block.tool_use_id)
        if (callId === undefined) continue
        const text = userText(block.content) ?? (typeof block.content === 'string' ? block.content : '')
        const child = /(?:^|\n)agentId: ([^\s\n]+)/u.exec(text)?.[1]
        if (child !== undefined) childOfResult.set(callId, child)
      }
    }
  }
  indexHandBackIds(messages)
  for (const transcript of uniqueTranscripts) indexHandBackIds(transcript.messages)
  /** Per delegator ('' = the main chain): how many of its `Agent` calls NO
   *  exact channel can attribute (neither a call-id keyed transcript nor a
   *  hand-back result naming an available child). The fail-closed join
   *  (RV round 4) only ever pairs a SOLE such call with a SOLE unclaimed
   *  candidate — anything less is a guess, and a guess cross-wires bodies
   *  onto the wrong call's card (the map order is the store's traversal
   *  order, not the parent's call order). */
  const nonExactCalls = new Map<string, number>()
  const censusCalls = (source: readonly unknown[], owner: string): void => {
    for (const raw of source) {
      const message = rec(raw)
      if (message === undefined || message.type !== 'assistant') continue
      for (const block of arr(rec(message.message)?.content).map(rec)) {
        if (block?.type !== 'tool_use') continue
        const callId = str(block.id)
        const name = str(block.name)
        if (callId === undefined || name === undefined || !AGENT_TOOLS.has(name)) continue
        const keyed = options.subagents?.has(callId) === true
        const namedChild = childOfResult.get(callId)
        const namedAvailable = namedChild !== undefined && (options.subagents?.has(namedChild) === true || uniqueTranscripts.some(seen => seen.agentId === namedChild))
        if (!keyed && !namedAvailable) nonExactCalls.set(owner, (nonExactCalls.get(owner) ?? 0) + 1)
      }
    }
  }
  censusCalls(messages, '')
  for (const transcript of uniqueTranscripts) censusCalls(transcript.messages, transcript.agentId)
  /** The unclaimed transcript of an exact child id, if the store kept it. */
  const unclaimedByAgentId = (agentId: string): ClaudeSubagentTranscript | undefined => {
    if (claimed.has(agentId)) return undefined
    return uniqueTranscripts.find(seen => seen.agentId === agentId)
  }
  /** The unclaimed candidates naming this delegator as parent (for the main
   *  chain: no parent agent recorded — depth-1 or old-format metadata). */
  const unclaimedCandidatesOf = (delegatorId: string | undefined): readonly ClaudeSubagentTranscript[] =>
    uniqueTranscripts.filter(seen => !claimed.has(seen.agentId) && (delegatorId === undefined ? seen.parentAgentId == null : seen.parentAgentId === delegatorId))
  /**
   * The SOLE unclaimed candidate for a delegator, attached only when the
   *  attribution is provably unique (design §2 / RV round 4): the delegator
   *  made exactly ONE call no exact channel attributes, exactly one
   *  candidate names it as parent, and the transcript source is complete —
   *  a main chain that began at a compaction may have dropped the call the
   *  child actually belongs to. Otherwise undefined: the child stays
   *  unattached rather than cross-wired onto an arbitrary call.
   */
  const soleUnclaimedChildOf = (delegatorId: string | undefined): ClaudeSubagentTranscript | undefined => {
    if (delegatorId === undefined && compactedFrom !== undefined) return undefined
    if ((nonExactCalls.get(delegatorId ?? '') ?? 0) !== 1) return undefined
    const candidates = unclaimedCandidatesOf(delegatorId)
    return candidates.length === 1 ? candidates[0] : undefined
  }

  const closeTurn = (): void => {
    if (!translator.turnOpen) { interrupted = false; return }
    out.push(...translator.forceCloseTurn(interrupted ? { kind: 'aborted' } : { kind: 'completed' }))
    interrupted = false
  }

  const endSubagent = (callId: string, outcome: SubagentOutcome): void => {
    const agent = launched.get(callId)
    if (agent === undefined) return
    launched.delete(callId)
    out.push({
      type: 'subagent.end',
      agentId: agent.agentId,
      status: outcome.status,
      ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
      ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
      time: clock,
    })
  }

  const assistant = (message: Rec): void => {
    const body = rec(message.message)
    const id = str(body?.id)
    const messageModel = str(body?.model)
    if (messageModel !== undefined && messageModel !== '' && messageModel !== '<synthetic>') model = messageModel
    out.push(...translator.translate({ type: 'assistant', message: body, uuid: message.uuid, parent_tool_use_id: null }))
    const blocks = arr(body?.content).map(rec)
    // The count row the live `thinking_tokens` estimate produces, from the
    // API's own count (once per API message: every block entry repeats it).
    if (id !== undefined && !counted.has(id) && blocks.some(block => block?.type === 'thinking' && (str(block.thinking) ?? '') === '')) {
      counted.add(id)
      const thinking = num(rec(rec(body?.usage)?.output_tokens_details)?.thinking_tokens)
      if (thinking !== undefined && thinking > 0) out.push(...translator.translate({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: thinking }))
    }
    delegations(blocks, 0, undefined)
  }

  /**
   * The `Agent` calls among some assistant blocks (of the main chain, or of
   * a subagent's own transcript — a nested delegation): each one launched a
   * subagent (the translator pre-created it from the call); when the
   * session kept that subagent's transcript, its own id completes it and its
   * messages follow as its lane. `delegatorId` is the agent whose transcript
   * the calls sit in (undefined = the main chain) — a transcript whose call
   * attribution is missing heals onto it by `parent_agent_id`.
   */
  const delegations = (blocks: readonly (Rec | undefined)[], depth: number, delegatorId: string | undefined): void => {
    for (const block of blocks) {
      if (block?.type !== 'tool_use') continue
      const callId = str(block.id)
      const name = str(block.name)
      if (callId === undefined || name === undefined || !AGENT_TOOLS.has(name) || launched.has(callId)) continue
      const input = rec(block.input)
      const background = input?.run_in_background === true
      const byCall = depth < MAX_NESTING ? options.subagents?.get(callId) : undefined
      let transcript: ClaudeSubagentTranscript | undefined = byCall !== undefined && !claimed.has(byCall.agentId) ? byCall : undefined
      let via = transcript !== undefined ? 'call id' : undefined
      if (transcript === undefined && depth < MAX_NESTING) {
        // Exact, falsifiable: the call's recorded hand-back names the child.
        const named = childOfResult.get(callId)
        transcript = named === undefined ? undefined : unclaimedByAgentId(named)
        if (transcript !== undefined) via = 'hand-back agent id'
        else {
          // Fail-closed bijection (RV round 4): provably-unique only.
          transcript = soleUnclaimedChildOf(delegatorId)
          if (transcript !== undefined) via = 'unique-candidate bijection'
        }
      }
      if (via !== undefined && transcript !== byCall) debug(`claude replay: subagent transcript attached by ${via}`)
      launched.set(callId, { agentId: transcript?.agentId ?? callId, background })
      if (transcript === undefined) continue
      claimed.add(transcript.agentId)
      // The parent fact the disk structure states: the recorded
      // parent_agent_id wins; the transcript the delegating call sits in
      // (delegatorId — undefined = the main chain) is the structural
      // fallback. depth is emitted ALWAYS now: a main-chain delegation is
      // a depth-1 spawn by construction, and the roster's parent/sibling
      // math treats depth 1 as proof of a main-loop child (agent-team §2
      // forbids inferring parents from depth any deeper than that).
      const parentAgentId = transcript.parentAgentId ?? delegatorId
      out.push({
        type: 'subagent.start',
        agentId: transcript.agentId,
        parentCallId: callId,
        description: str(input?.description) ?? '',
        ...(str(input?.subagent_type) === undefined ? {} : { kind: str(input?.subagent_type) }),
        background,
        depth: depth + 1,
        ...(parentAgentId === undefined ? {} : { parentAgentId }),
        time: clock,
      })
      lane(callId, transcript, depth + 1)
    }
  }

  /** A subagent's own messages, as the live lane delivered them; the
   *  subagents IT delegated to end from its own results. */
  const lane = (callId: string, transcript: ClaudeSubagentTranscript, depth: number): void => {
    for (const raw of transcript.messages) {
      const message = rec(raw)
      if (message === undefined || (message.type !== 'assistant' && message.type !== 'user')) continue
      const time = Date.parse(str(message.timestamp) ?? '')
      if (Number.isFinite(time)) clock = time
      out.push(...translator.translate({ ...message, parent_tool_use_id: callId }))
      const content = arr(rec(message.message)?.content).map(rec)
      if (message.type === 'assistant') {
        delegations(content, depth, transcript.agentId)
        continue
      }
      const structured = rec(message.tool_use_result ?? message.toolUseResult)
      for (const block of content) endFromResult(block, structured)
    }
  }

  /** A recorded tool result that ends the subagent its call launched (a
   *  background one's result only acknowledges the launch). */
  const endFromResult = (block: Rec | undefined, structured: Rec | undefined): void => {
    if (block?.type !== 'tool_result') return
    const callId = str(block.tool_use_id)
    const agent = callId === undefined ? undefined : launched.get(callId)
    if (callId === undefined || agent === undefined) return
    const text = userText(block.content) ?? (typeof block.content === 'string' ? block.content : '')
    if (agent.background || ASYNC_LAUNCH.test(text) || structured?.status === 'async_launched' || structured?.isAsync === true) {
      agent.background = true
      return
    }
    endSubagent(callId, resultOutcome(block))
  }

  const user = (message: Rec): void => {
    const uuid = str(message.uuid) ?? `replay-${translator.seqNumber + 1}`
    const kind = classifyUser(message)
    switch (kind.kind) {
      case 'results': {
        // The raw transcript file keeps the structured result the read API
        // drops (richer cards when "load earlier" replays it).
        const structured = message.tool_use_result ?? message.toolUseResult
        out.push(...translator.translate({ type: 'user', uuid, message: message.message, parent_tool_use_id: null, ...(structured === undefined ? {} : { tool_use_result: structured }) }))
        // A background subagent's result only acknowledges the launch; its
        // end is the notification naming it.
        for (const raw of arr(rec(message.message)?.content)) endFromResult(rec(raw), rec(structured))
        return
      }
      case 'summary':
        closeTurn()
        out.push(...translator.translate({ type: 'system', subtype: 'compact_boundary', compact_metadata: {} }))
        out.push(...translator.translate({ type: 'user', uuid, isSynthetic: true, message: { role: 'user', content: kind.text }, parent_tool_use_id: null }))
        return
      case 'prompt':
        // A prompt folded into a running turn joins it; any other prompt
        // starts the next turn.
        if (!kind.queued) closeTurn()
        // Images sent with it: lazy facades over the base64 the transcript
        // holds (nothing decoded until shown).
        translator.registerInput(uuid, kind.text, 'turn', transcriptImages(rec(message.message)?.content, uuid))
        out.push(...translator.translate({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' }))
        return
      case 'interrupt':
        interrupted = true
        return
      case 'notification': {
        // The notification a background subagent's end was reported with.
        const notice = notificationOf(userText(rec(message.message)?.content) ?? '')
        const callId = notice.callId !== undefined && launched.has(notice.callId)
          ? notice.callId
          : [...launched].find(([, agent]) => agent.agentId === notice.taskId)?.[0]
        if (callId !== undefined) {
          const status = notice.status === 'completed' ? 'completed' : notice.status === 'failed' ? 'failed' : notice.status === 'stopped' || notice.status === 'killed' ? 'cancelled' : 'unknown'
          endSubagent(callId, { status, ...(notice.summary === undefined ? {} : { summary: notice.summary }) })
        }
        closeTurn()
        out.push(...translator.openNotificationTurn())
        return
      }
      case 'hidden':
        debug(`claude replay: ${kind.why} user message not projected`)
        return
      default: {
        const unknown: never = kind
        return unknown
      }
    }
  }

  // A chain that begins at a compaction (the boundary entry, then the
  // summary) has older history on disk.
  const first = rec(messages[0])
  const second = rec(messages[1])
  const compactedFrom = first?.isCompactSummary === true
    ? str(first.uuid)
    : first?.type === 'system' && second?.isCompactSummary === true ? str(first.uuid) : undefined
  for (const raw of messages) {
    const message = rec(raw)
    if (message === undefined) continue
    const time = Date.parse(str(message.timestamp) ?? '')
    if (Number.isFinite(time)) clock = time
    // Subagent traffic never interleaves with the main transcript.
    if ((message.parent_tool_use_id !== undefined && message.parent_tool_use_id !== null) || message.isSidechain === true) continue
    switch (message.type) {
      case 'assistant':
        assistant(message)
        break
      case 'user':
        user(message)
        break
      default:
        // System entries reach the read API without their subtype; the one
        // that matters (a compact boundary) is replayed from the summary
        // that follows it.
        break
    }
  }
  closeTurn()
  // No recorded end (a nested delegation included): the CLI that ran it is
  // gone, its state is unknown.
  for (const callId of [...launched.keys()]) endSubagent(callId, { status: 'unknown' })
  if (options.title !== undefined && options.title !== '') out.push({ type: 'session.title', title: options.title, source: 'auto' })
  if (model !== undefined) out.push({ type: 'model.changed', model, source: 'resume' })
  const tasks = translator.taskSeeds()
  return {
    events: out,
    start: { turn: translator.turnNumber, seq: translator.seqNumber, ...(model === undefined ? {} : { model }) },
    ...(tasks.length === 0 ? {} : { tasks }),
    ...(compactedFrom === undefined ? {} : { compactedFrom }),
  }
}

/** A subagent's own transcript replayed as its child lane (design
 *  agent-team-panels §2): every user/assistant message goes through the
 *  SAME translator the live lane uses (thinking/text blocks, tool calls
 *  and results), with `parent_tool_use_id` forced to the child's own agent
 *  id — a message whose store metadata lacks the delegating call id must
 *  never fall through to the MAIN lane translation. Thinking the API only
 *  signed or counted (empty text) degrades honestly: a `reasoning-tokens`
 *  block carries the count, a `reasoning-signature` block says even that
 *  is unknown — the view renders "body unavailable", never fabricated
 *  prose. The child's initial prompt stays hidden (the translator's
 *  standing contract). Pure: no I/O, no clock (times come from the
 *  message timestamps). */
export interface ClaudeSubagentLane {
  readonly events: readonly AgentEvent[]
  /** `parent_agent_id` across the child's messages; null = depth-1 or
   *  old-format metadata (sdk.d.ts:6437-6449). */
  readonly parentAgentId: string | null
  readonly uuids: readonly string[]
}

export function replayClaudeSubagentLane(
  agentId: string,
  messages: readonly unknown[],
  options: { readonly cwd: string; readonly debug?: (message: string) => void },
): ClaudeSubagentLane {
  const debug = options.debug ?? (() => undefined)
  let clock = 0
  let seq = 0
  const translator = createClaudeTranslator({ cwd: options.cwd, userRows: 'lifecycle', now: () => clock, debug })
  const events: AgentEvent[] = []
  const uuids: string[] = []
  let parentAgentId: string | null = null
  const nextSeq = (): number => { seq += 1; return seq }
  for (const raw of messages) {
    const message = rec(raw)
    if (message === undefined || (message.type !== 'assistant' && message.type !== 'user')) continue
    const uuid = str(message.uuid)
    if (uuid !== undefined) uuids.push(uuid)
    if (typeof message.parent_agent_id === 'string') parentAgentId = message.parent_agent_id
    const time = Date.parse(str(message.timestamp) ?? '')
    if (Number.isFinite(time)) clock = time
    if (message.type === 'assistant') {
      const body = rec(message.message)
      const blocks = arr(body?.content).map(rec)
      // Count/signature-only thinking (the API returns signatures, not
      // bodies, unless summaries are enabled) becomes a marker block the
      // transcript view renders as an honest "body unavailable" row.
      if (blocks.some(block => block?.type === 'thinking' && (str(block?.thinking) ?? '') === '')) {
        const tokens = num(rec(rec(body?.usage)?.output_tokens_details)?.thinking_tokens)
        events.push({
          type: 'assistant.message',
          seq: nextSeq(),
          anchor: str(body?.id) ?? uuid ?? `lane-${seq}`,
          attemptId: str(body?.id) ?? uuid ?? `lane-${seq}`,
          time: clock,
          blocks: [tokens !== undefined && tokens > 0 ? { type: 'reasoning-tokens', text: String(tokens) } : { type: 'reasoning-signature', text: '' }],
          canonical: false,
          parentCallId: agentId,
        })
      }
    }
    events.push(...translator.translate({ ...message, parent_tool_use_id: agentId }))
  }
  return { events, parentAgentId, uuids }
}
/**
 * The uuid of the chain entry right before `anchor` — where a conversation
 * rewind cuts (`forkSession({upToMessageId})` keeps it, inclusive). Undefined
 * when `anchor` is not in the chain or is its first entry (nothing precedes
 * it: there is no conversation to rewind to).
 */
export function rewindCutPoint(messages: readonly unknown[], anchor: string): string | undefined {
  const index = messages.findIndex(message => rec(message)?.uuid === anchor)
  if (index <= 0) return undefined
  return str(rec(messages[index - 1])?.uuid)
}

/** The trailing exchanges of a chain, for the browser's preview (newest last). */
export function previewEntries(messages: readonly unknown[], limit: number): { role: 'user' | 'assistant'; text: string; at: number | undefined }[] {
  const entries: { role: 'user' | 'assistant'; text: string; at: number | undefined }[] = []
  /** The API message the last assistant entry came from (one entry per
   *  block on disk: their text joins into one exchange). */
  let lastAssistantId: string | undefined
  for (const raw of messages) {
    const message = rec(raw)
    if (message === undefined || (message.parent_tool_use_id !== undefined && message.parent_tool_use_id !== null)) continue
    const at = Date.parse(str(message.timestamp) ?? '')
    const time = Number.isFinite(at) ? at : undefined
    if (message.type === 'user') {
      const kind = classifyUser(message)
      if (kind.kind !== 'prompt') continue
      entries.push({ role: 'user', text: kind.text.trim(), at: time })
      lastAssistantId = undefined
      continue
    }
    if (message.type !== 'assistant') continue
    const body = rec(message.message)
    const text = arr(body?.content).flatMap(block => rec(block)?.type === 'text' ? [str(rec(block)?.text) ?? ''] : []).join('').trim()
    if (text === '') continue
    const id = str(body?.id)
    const last = entries.at(-1)
    if (last !== undefined && last.role === 'assistant' && id !== undefined && id === lastAssistantId) last.text = `${last.text}\n${text}`
    else entries.push({ role: 'assistant', text, at: time })
    lastAssistantId = id
  }
  return entries.slice(-limit)
}
