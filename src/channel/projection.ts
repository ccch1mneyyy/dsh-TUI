/**
 * The shared reducer (docs/agent-backend-design.md): Agent Domain events in,
 * `ChannelState` mutations out, for every backend and for durable replay and
 * the live stream alike. Decoding a backend's native events is not done here:
 * a translator (`src/dsh-adapter/backend/translate.ts` for DSH) produces the
 * `AgentEvent`s; this module only folds them.
 *
 * The DSH projection goldens (`scripts/fixtures/dsh/*.golden.json`) pin its
 * behaviour: attempt start/discard/revive, `seq` idempotency, legacy
 * overlapping-prefix delta merge, thinking preview/full folding, TPS
 * turn/step accounting, token/cost bucketing, compaction context reset,
 * goal/todo/preset/title/colour, question/subagent card suppression and the
 * plugin renderer seam. The order of wall-clock reads is part of that
 * contract (the goldens pin `startedAt`/`durationMs` with a stepping clock).
 */
import type { ChannelUi } from '../adapter/ports/channel-ui.js'
import type { ChatRow, SelectionAttachment, TodoPanelItem, ToolCallView, TurnUsageSummary } from '../adapter/ports/channel-view.js'
import { markChannelReadDirty } from '../adapter/channel/read-view.js'
import type { AgentEvent, AgentEventMeta, AgentEventOf, ContentBlockView, GoalSnapshot, ImageRef } from '../agent/events.js'
import { t } from '../i18n.js'
import { logForDebugging } from '../utils/debug.js'
import { laneOf } from './activity.js'
import { buildQuestionRecord, parseQuestionRecordAnswers, parseQuestionRecordQuestions } from './question-record.js'
import { cleanRenderText, NOTICE_CELLS } from './sanitize.js'
import { replaySelectionAttachment } from './selection-record.js'
import { ARGS_PREVIEW_LIMIT, LOCAL_OUTPUT_LIMIT, preview, RESULT_PREVIEW_LIMIT } from './transcript.js'
import { addUsageToBucket, emptyCostBuckets, estimateTokens, usageOutputTokens, type PricingWindow } from './usage.js'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** Notice keys whose live toast is tracked (a repeat replaces it). */
const MAX_KEYED_TOASTS = 32

/** The channel state slice the projector writes. */
export interface ProjectionState extends Mutable<Pick<ChannelUi,
  | 'thinkingFold' | 'activeToolCount' | 'spinnerMode' | 'goal' | 'contextSegments' | 'tokens' | 'mainCost'
  | 'model' | 'lastUsage' | 'turnUsage' | 'lastUserText' | 'responseChars' | 'tps' | 'cancelPending' | 'working'
  | 'compaction' | 'turnStart' | 'contextWindow' | 'reasoningEffort' | 'sessionTitle' | 'agentPreset' | 'sessionColor'
  | 'costReport'
>> {
  rows: ChatRow[]
  tpsSamples: { tps: number; at: number }[]
  todos: TodoPanelItem[]
}

/** Plugin custom-entry renderer (tuiRenderers seam), structurally. */
export interface ProjectionRenderer {
  render(type: string, data: unknown): { readonly title?: string; readonly lines: readonly unknown[] } | undefined
}

/** Everything the projector needs from its channel. */
export interface ChannelProjectionDeps {
  rowIds: { value: number }
  resetContextWarning(): void
  checkContextWarning(): void
  notify: ChannelUi['notify']
  /** Background-job registry feed (DSH `jobs` service mirror). */
  jobs: { onOutputSeen(id: string, text: string, at?: number): void; onStarted(id: string, command: string): void }
  /**
   * The backend-neutral subagent / background-task projection
   * (`./activity.ts`): every `subagent.*` / `task.*` / `tasks.snapshot` event
   * and every child-lane event (`parentCallId` set) is handed to it in stream
   * order, so its transcript cards land where the delegation happened. Child-
   * lane events never reach the main transcript. Absent (a DSH composition,
   * whose specialists own these facts) = nothing is forwarded.
   */
  activity?: { apply(event: AgentEvent, replaying: boolean): void }
  /**
   * The core's trajectory fold: every event in stream order, child-lane
   * ones included (their subagent lifecycle still maps onto the parent's
   * ledger), feeds the neutral raw-event source behind `traceEvents()`.
   * Absent (a DSH composition, whose raw history is the source) = nothing
   * is forwarded.
   */
  trajectory?: { observe(event: AgentEvent, replaying: boolean): void }
  inputConvergence: { cancelInFlight: boolean }
  renderer?: ProjectionRenderer
  /** What a submitted message's IDE selection attached (keyed by the message
   *  id the durable event carries), for the user row's indicator line. */
  selectionAttached(messageId: string): SelectionAttachment | undefined
  /**
   * Rate window a usage at `time` bills under. Injected by the backend that
   * owns the pricing policy (DSH: the DeepSeek peak hours); absent → every
   * usage lands in the `idle` bucket.
   */
  pricingWindow?: (time: number) => PricingWindow
}

const NO_IMAGES: readonly ImageRef[] = []

/** Joined, trimmed text of every `text` block (what a bubble or card body shows). */
export function textOfBlocks(blocks: readonly ContentBlockView[] | undefined): string {
  // Unknown block kinds are skipped, never fatal (v1 renders text blocks only).
  return (blocks ?? []).map(block => (block.type === 'text' ? block.text : '')).join('').trim()
}

/** Create the shared projector over one channel state. */
export function createChannelProjection(state: ProjectionState, deps: ChannelProjectionDeps) {
  /** The in-progress assistant text row; `undefined` when no step is streaming. */
  let streaming: ChatRow | undefined
  /** The in-progress reasoning row; `undefined` when no reasoning is streaming. */
  let reasoning: ChatRow | undefined
  /** Reasoning rows sealed this turn. Full mode keeps them expanded until
   *  turn end without leaving their streaming spinner active. */
  const sealedReasoning: ChatRow[] = []
  /** Wall-clock start of the current reasoning row (durationMs on settle). */
  let reasoningStart = 0
  /** Decode-throughput fold for the current turn. One step is one model call
   *  plus its tools; summing only first-token → message spans excludes tool
   *  execution and per-request TTFT from generation speed. */
  let tpsTurn: number | undefined
  let tpsBeforeTurn: number | undefined
  let tpsTurnDecodeMs = 0
  let tpsTurnDecodeTokens = 0
  let tpsTurnSampled = false
  let tpsStep:
    | {
      turn: number
      step: number
      firstTokenTime: number | undefined
      outputChars: number
    }
    | undefined
  /** Per-turn usage ledger: reset at turn.start, summed from each assistant
   *  message's own request usage (messages report per-request increments, so
   *  a turn-level backend report must never be added on top), rendered as
   *  the turn-summary row at turn.end and kept on `state.turnUsage` for the
   *  footer readouts. */
  const turnLedger = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheKnown: false,
    usageSeen: false,
    startedAt: 0,
    model: undefined as string | undefined,
  }
  /** Attempt ids that failed and were superseded within the current turn
   *  (API retries): a set, because the same failure can be observed from
   *  both the superseding attempt.start and the positioned attempt.end. */
  const turnFailedAttempts = new Set<string>()
  /** Model of the last emitted turn ledger: the row names the model only
   *  when it changed (or on the first turn that has one), since repeating an
   *  unchanged id every turn is noise. Commands read `model` regardless. */
  let lastNotedTurnModel: string | undefined
  /** Tool cards by callId, so the result can settle the running card. */
  const toolCards = new Map<string, ChatRow>()
  /**
   * Question-presented calls by callId, holding their raw arguments. The ask
   * renders as the interactive panel rather than a tool card, so its result
   * has no card to settle, but the answered record still belongs in the
   * transcript and must come from the durable log (issue #1009), never from
   * the view. Remembering the call lets the result derive that record on the
   * live stream and on every replay (`/resume`, rewind, model switch).
   */
  const askCalls = new Map<string, string>()
  /** Todo-panel calls by callId (cards suppressed: the panel shows the
   *  list). Their arguments are remembered so a failed result can still
   *  render its error card. Otherwise a rejected TaskUpdate would vanish
   *  silently: the panel rolls back its optimistic change, and the user
   *  needs to see that the task change never happened. */
  const todoCalls = new Map<string, { name: string; argsJson: string; seq: number; time: number }>()
  /** callId of the result that just settled an ok card: task feeds a
   *  translator derives from a result only reach the job registry when that
   *  result actually settled a card here. */
  let settledCardCallId: string | undefined
  /**
   * Session events are delivered live and can also be replayed around a
   * reconnect. A repeated sealed message must not create a second assistant
   * row for the same durable sequence number.
   */
  const handledAssistantMessages = new Set<number>()
  const handledAssistantChunks = new Set<number>()
  /** One agent runs one request at a time. Durable step boundaries also let
   *  a freshly attached projector accept deltas whose attempt start it missed. */
  let openStep: { turn: number; step: number } | undefined
  let activeAttempt: { attemptId: string; turn: number; step: number } | undefined
  /** 最近一次 request.header 的模型，durable usage 按它归属模型。replay
   *  会按历史请求逐个还原，因此 /model 切换（reset + replay 整个 seed）
   *  不会把换模型前的用量重估到新模型；旧日志没有 header 时回退
   *  事件发生时的 state.model。 */
  let eventModel: string | undefined
  const assistantRowsByStep = new Map<string, ChatRow>()
  /**
   * Assistant rows by the seq they carry: a reconnect can replay a delta or
   * settlement of a row already on screen, which must reuse that row. Live
   * events only see rows this projector opened or settled since the last
   * replay; rows prepended by "load earlier" come from a separate projection
   * whose seqs may overlap live ones and are never matched.
   */
  const assistantRowsBySeq = new Map<number, ChatRow>()
  const lastTextDelta = new Map<ChatRow, string>()
  const stepKey = (turn: number, step: number): string => `${turn}:${step}`
  const touchRow = (row: ChatRow): void => { markChannelReadDirty(row); markChannelReadDirty(state.rows) }
  /** The last keyed notice row (updated in place while it stays last). */
  let keyedNoticeRow: { readonly key: string; readonly row: ChatRow } | undefined
  /** The live toast of each notice key (a repeat replaces it). */
  const keyedToasts = new Map<string, () => void>()
  const appendRow = (row: ChatRow): void => { state.rows.push(row); markChannelReadDirty(state.rows) }
  const removeRow = (row: ChatRow): void => {
    const index = state.rows.indexOf(row)
    if (index !== -1) {
      state.rows.splice(index, 1)
      markChannelReadDirty(state.rows)
    }
    if (streaming === row) streaming = undefined
    if (reasoning === row) reasoning = undefined
    if (lastReasoningRow?.row === row) lastReasoningRow = undefined
    const sealedIndex = sealedReasoning.indexOf(row)
    if (sealedIndex !== -1) sealedReasoning.splice(sealedIndex, 1)
    lastTextDelta.delete(row)
    if (row.seq !== undefined && assistantRowsBySeq.get(row.seq) === row) assistantRowsBySeq.delete(row.seq)
  }

  const discardAttempt = (turn: number, step: number): void => {
    const key = stepKey(turn, step)
    const row = assistantRowsByStep.get(key)
    if (row !== undefined && row.seq === undefined) {
      state.responseChars = Math.max(0, state.responseChars - row.text.length)
      removeRow(row)
      assistantRowsByStep.delete(key)
    }
    if (lastReasoningRow !== undefined && lastReasoningRow.turn === turn && lastReasoningRow.step === step && lastReasoningRow.row.seq === undefined) {
      removeRow(lastReasoningRow.row)
    }
    if (activeAttempt !== undefined && activeAttempt.turn === turn && activeAttempt.step === step) activeAttempt = undefined
    if (tpsStep !== undefined && tpsStep.turn === turn && tpsStep.step === step) {
      tpsStep.firstTokenTime = undefined
      tpsStep.outputChars = 0
    }
    updateSpinnerMode()
  }

  /** Live deltas are ordered by the backend's stream fence and must stay
   * byte-exact. Positioned (legacy durable) deltas may instead repeat a
   * cumulative prefix after a reconnect/proxy replay. */
  const appendTextDelta = (row: ChatRow, delta: string, legacy: boolean): void => {
    if (delta === '') return
    if (!legacy) {
      row.text += delta
      touchRow(row)
      return
    }
    if (lastTextDelta.get(row) === delta) return
    lastTextDelta.set(row, delta)
    if (delta.startsWith(row.text)) {
      row.text = delta
      touchRow(row)
      return
    }
    const maxOverlap = Math.min(row.text.length, delta.length, 4096)
    for (let size = maxOverlap; size > 0; size--) {
      if (row.text.endsWith(delta.slice(0, size))) {
        row.text += delta.slice(size)
        touchRow(row)
        return
      }
    }
    row.text += delta
    touchRow(row)
  }

  const indexAssistantRow = (row: ChatRow): void => {
    if (row.seq !== undefined) assistantRowsBySeq.set(row.seq, row)
  }

  const openStreaming = (seq?: number): ChatRow => {
    streaming = { id: deps.rowIds.value, kind: 'assistant', text: '', streaming: true, fresh: true, ...seq !== undefined ? { seq } : {} }
    deps.rowIds.value += 1
    appendRow(streaming)
    indexAssistantRow(streaming)
    return streaming
  }

  const ensureStreaming = (seq?: number): ChatRow => {
    if (streaming !== undefined) return streaming
    // A reconnect can replay the first delta after the sealed message was
    // already observed. Reuse that durable row instead of opening a second
    // assistant bubble for the same event sequence.
    const existing = seq === undefined ? undefined : assistantRowsBySeq.get(seq)
    if (existing !== undefined) {
      existing.streaming = true
      touchRow(existing)
      streaming = existing
      return existing
    }
    return openStreaming(seq)
  }

  /** Latest reasoning row keyed by its (turn, step), so a resumed mid-step
   *  stream revives the row the replay sealed (crash-orphan tail: replay
   *  folds the partial row, and live continuation deltas would otherwise
   *  open a second row for the same step, splitting one thinking block in
   *  two). */
  let lastReasoningRow: { row: ChatRow; turn: number; step: number } | undefined

  const ensureReasoning = (seq?: number, turn?: number, step?: number): ChatRow => {
    if (reasoning === undefined) {
      // Same-step revive: the sealed row is this step's thinking — continue
      // it (durationMs carried over via reasoningStart back-dating).
      if (
        lastReasoningRow !== undefined &&
        turn !== undefined &&
        lastReasoningRow.turn === turn &&
        lastReasoningRow.step === step
      ) {
        reasoning = lastReasoningRow.row
        reasoning.streaming = true
        reasoning.thinkingOpen = false
        touchRow(reasoning)
        const sealedIdx = sealedReasoning.indexOf(reasoning)
        if (sealedIdx !== -1) sealedReasoning.splice(sealedIdx, 1)
        reasoningStart = Date.now() - (reasoning.durationMs ?? 0)
        logForDebugging('thinking: revived sealed reasoning row for same step')
        return reasoning
      }
      reasoningStart = Date.now()
      reasoning = { id: deps.rowIds.value, kind: 'reasoning', text: '', streaming: true, ...seq !== undefined ? { seq } : {} }
      deps.rowIds.value += 1
      appendRow(reasoning)
      logForDebugging('thinking: reasoning row open (expanded)')
    }
    if (turn !== undefined && step !== undefined) {
      lastReasoningRow = { row: reasoning, turn, step }
    }
    return reasoning
  }

  /** Settle live reasoning the moment the model moves past thinking (the
   *  answer's first text token or a tool call), not at the settled message
   *  (end of step). A long reply pushes the thinking block into terminal
   *  scrollback long before the message seals, and scrollback rows cannot be
   *  repainted (the cursor cannot reach them), so a late fold leaves a stale
   *  unfolded preview above the window. Folding while the block still sits
   *  in the live window keeps the shrink inside the diff engine's reachable
   *  region. Full mode keeps the settled block open separately, so its
   *  spinner can stop immediately. */
  const settleLiveReasoning = (where: string): void => {
    if (reasoning === undefined) return
    const duration = Math.max(0, Date.now() - reasoningStart)
    reasoning.durationMs = duration
    reasoning.streaming = false
    reasoning.thinkingOpen = state.thinkingFold === 'full'
    touchRow(reasoning)
    sealedReasoning.push(reasoning)
    reasoning = undefined
    logForDebugging(`thinking: folded at ${where} (${duration}ms)`)
  }

  const settleStreaming = (): void => {
    if (streaming !== undefined) { streaming.streaming = false; touchRow(streaming) }
    streaming = undefined
    const folded = sealedReasoning.length + (reasoning !== undefined ? 1 : 0)
    for (const row of sealedReasoning) { row.streaming = false; row.thinkingOpen = false; touchRow(row) }
    sealedReasoning.length = 0
    if (reasoning !== undefined) {
      reasoning.streaming = false
      reasoning.thinkingOpen = false
      reasoning.durationMs = Math.max(0, Date.now() - reasoningStart)
      touchRow(reasoning)
    }
    reasoning = undefined
    if (folded > 0) logForDebugging(`thinking: folded ${folded} reasoning row(s) at turn settle`)
  }

  /**
   * Project one answered question-presented result into the transcript.
   *
   * The row shape reuses what `pushLocal` emits (`local` title + one
   * `local-output` per line), so rendering, preview clipping and the local
   * rows' fold exemption all keep their existing behavior. A failed ask
   * renders the log's own error text — never a fabricated answer (the ask
   * was cancelled/aborted, so no human ever chose anything).
   */
  const projectAskResult = (event: AgentEventOf<'tool.result'>, rawArguments: string): void => {
    const append = (record: { title: string; lines: readonly string[] }): void => {
      appendRow({ id: deps.rowIds.value, kind: 'local', text: record.title, seq: event.seq })
      deps.rowIds.value += 1
      for (const line of record.lines) {
        appendRow({
          id: deps.rowIds.value,
          kind: 'local-output',
          text: preview(line, LOCAL_OUTPUT_LIMIT),
          seq: event.seq,
        })
        deps.rowIds.value += 1
      }
    }
    if (event.isError) {
      append({ title: event.errorText ?? '', lines: [] })
      return
    }
    const answers = parseQuestionRecordAnswers(event.text)
    // No parseable answers (unparseable durable payload, or an older host):
    // `answers: []` still yields the title, so the transcript shows that a
    // questionnaire happened instead of dropping the fact silently.
    append(buildQuestionRecord(parseQuestionRecordQuestions(rawArguments), answers ?? []))
  }

  /** Recompute the spinner phase from live row/tool state. */
  const updateSpinnerMode = (): void => {
    if (state.activeToolCount > 0) {
      state.spinnerMode = 'tool-use'
    } else if (reasoning !== undefined) {
      // Only live reasoning counts: sealed rows stay streaming=true for
      // transcript expansion until turn end but the model is past thinking.
      state.spinnerMode = 'thinking'
    } else if (streaming !== undefined) {
      state.spinnerMode = 'responding'
    } else {
      state.spinnerMode = 'requesting'
    }
  }

  /** Fold one goal mutation into the channel's goal projection. */
  const applyGoalChange = (operation: string, goal: GoalSnapshot | undefined, roundsStarted: number | undefined): void => {
    if (operation === 'clear') {
      state.goal = undefined
    } else if (goal !== undefined) {
      state.goal = {
        ...goal,
        roundsStarted: roundsStarted ?? state.goal?.roundsStarted ?? 0,
      }
    }
  }

  /** Replay paints settled history without the live smooth-reveal animation. */
  let replaying = false

  type Delta = AgentEventOf<'assistant.delta'>['delta']
  /** Whether one delta advances the first-token/decode boundary. */
  const isTokenDelta = (delta: Delta): boolean => {
    switch (delta.kind) {
      case 'text':
      case 'reasoning':
        return delta.text !== ''
      case 'tool-args':
        return delta.partialJson !== '' || delta.name !== undefined
      default:
        return false
    }
  }
  /** Character payload of one token-bearing delta for the live fallback. */
  const tokenDeltaChars = (delta: Delta): number => {
    switch (delta.kind) {
      case 'text':
      case 'reasoning':
        return delta.text.length
      case 'tool-args':
        return (delta.name?.length ?? 0) + delta.partialJson.length
      default:
        return 0
    }
  }

  /**
   * One stream delta at a resolved (turn, step). `seq` exists only on
   * positioned (legacy durable) deltas, which use the overlap-tolerant merge.
   */
  const renderStreamDelta = (turn: number, step: number, delta: Delta, time: number, seq?: number): void => {
    if (delta.kind === 'text') {
      if (delta.text) {
        // Fold the thinking preview while it is still in the live window
        // (see settleLiveReasoning) — before this text grows the transcript
        // and pushes the block into scrollback.
        settleLiveReasoning('first text token')
        const key = stepKey(turn, step)
        const row = assistantRowsByStep.get(key) ?? ensureStreaming(seq)
        assistantRowsByStep.set(key, row)
        streaming = row
        row.streaming = true
        touchRow(row)
        const before = row.text.length
        appendTextDelta(row, delta.text, seq !== undefined)
        state.responseChars += Math.max(0, row.text.length - before)
      }
    } else if (delta.kind === 'reasoning') {
      if (delta.text) {
        const row = ensureReasoning(seq, turn, step)
        appendTextDelta(row, delta.text, seq !== undefined)
      }
    } else if (delta.kind === 'reasoning-tokens') {
      // Thinking reported only as an estimated token count:
      // the reasoning row opens with no text and shows the live count; text
      // that arrives later still wins in the view.
      const row = ensureReasoning(seq, turn, step)
      if (row.reasoningTokens !== delta.estimated) {
        row.reasoningTokens = delta.estimated
        touchRow(row)
      }
    }
    const tps = tpsStep
    if (
      tps !== undefined &&
      tps.turn === turn &&
      tps.step === step &&
      isTokenDelta(delta)
    ) {
      tps.firstTokenTime ??= time
      tps.outputChars += tokenDeltaChars(delta)
      const elapsedMs = Math.max(0, time - tps.firstTokenTime)
      if (elapsedMs > 500) {
        const decodeMs = tpsTurnDecodeMs + elapsedMs
        const outputTokens = tpsTurnDecodeTokens + Math.ceil(tps.outputChars / 4)
        state.tps = outputTokens / (decodeMs / 1000)
      }
    }
    updateSpinnerMode()
  }

  const applyAssistantMessage = (event: AgentEventOf<'assistant.message'>): void => {
    if (handledAssistantMessages.has(event.seq)) return
    handledAssistantMessages.add(event.seq)
    // A canonical settlement embeds its complete attempt; older settlements
    // may omit reasoning that is still durably recorded in legacy deltas.
    const canonical = event.canonical
    const text = textOfBlocks(event.blocks)
    const images = event.images ?? NO_IMAGES
    const reasoningText = event.blocks
      .map(block => (block.type === 'reasoning' ? block.text : ''))
      .join('')
    // A backend's own message anchor beyond the seq (DSH anchors are the
    // seq, so DSH rows carry none) is how "load earlier" finds the durable
    // message a folded row came from.
    const anchor = event.anchor === '' || event.anchor === String(event.seq) ? undefined : event.anchor
    const settledReasoning = lastReasoningRow !== undefined && lastReasoningRow.turn === event.turn && lastReasoningRow.step === event.step
      ? lastReasoningRow.row : reasoning
    if (settledReasoning !== undefined) {
      if (reasoningText === '') {
        // A count-only thinking row (no text was ever recorded) settles as
        // its one-line summary instead of vanishing with the empty block.
        if (canonical && settledReasoning.reasoningTokens === undefined) removeRow(settledReasoning)
        else if (anchor !== undefined && settledReasoning.anchor === undefined) settledReasoning.anchor = anchor
      } else {
        settledReasoning.text = reasoningText
        settledReasoning.seq ??= event.seq
        if (anchor !== undefined) settledReasoning.anchor ??= anchor
        touchRow(settledReasoning)
      }
    } else if (reasoningText !== '') {
      // Replays and reattachments may not have seen any reasoning delta.
      // Insert before a live text row to preserve message block order.
      const rebuilt: ChatRow = {
        id: deps.rowIds.value,
        kind: 'reasoning',
        text: reasoningText,
        seq: event.seq,
        ...(anchor === undefined ? {} : { anchor }),
      }
      deps.rowIds.value += 1
      const textRow = assistantRowsByStep.get(stepKey(event.turn as number, event.step as number))
      const textIndex = textRow === undefined ? -1 : state.rows.indexOf(textRow)
      if (textIndex === -1) appendRow(rebuilt)
      else { state.rows.splice(textIndex, 0, rebuilt); markChannelReadDirty(state.rows) }
    }
    // Reasoning/tool-only steps emit no text: creating an assistant row
    // anyway leaves an empty `●` bullet in the transcript. A pre-existing
    // streaming row always has text (ensureStreaming is only reached on
    // non-empty text deltas), so only create one when text arrives.
    // Key the step→row ledger only when the event carries a durable
    // turn/step; a message without them must never collide onto a
    // previous step's row (a bare `undefined:undefined` key would make
    // every turn/step-less message reuse the FIRST one's assistant row).
    const msgTurn = event.turn
    const msgStep = event.step
    const msgKey = msgTurn !== undefined && msgStep !== undefined
      ? stepKey(msgTurn, msgStep)
      : undefined
    const row = (msgKey !== undefined ? assistantRowsByStep.get(msgKey) : undefined) ?? streaming ??
      (text || images.length > 0 ? assistantRowsBySeq.get(event.seq) ?? openStreaming(event.seq) : undefined)
    if (row !== undefined && canonical && !text && images.length === 0) {
      removeRow(row)
      if (msgKey !== undefined) assistantRowsByStep.delete(msgKey)
    } else if (row !== undefined) {
      if (msgKey !== undefined) assistantRowsByStep.set(msgKey, row)
      row.seq ??= event.seq
      indexAssistantRow(row)
      if (anchor !== undefined) row.anchor ??= anchor
      row.time = event.time
      if (text || canonical) row.text = text
      row.images = images.length === 0 ? undefined : images
      row.streaming = false
      // Live settles keep the smooth-reveal cursor alive (a one-shot
      // non-streaming delivery still paints as a flow); replayed settles
      // must not, or the transcript would typewrite on open.
      if (!replaying && text) row.fresh = true
      touchRow(row)
    }
    streaming = undefined
    if (reasoning !== undefined) {
      // Backstop fold: reasoning whose step ended with no text token and no
      // tool call (settleLiveReasoning handles those earlier, while the block
      // is still in the repaintable live window; here a long reply may
      // already have pushed it into scrollback, where the shrink cannot be
      // repainted). `full` mode (/settings opt-in) keeps the block expanded
      // until turn settle; settleStreaming folds the sealed rows then.
      reasoning.durationMs = Math.max(0, Date.now() - reasoningStart)
      reasoning.streaming = false
      reasoning.thinkingOpen = state.thinkingFold === 'full'
      touchRow(reasoning)
      sealedReasoning.push(reasoning)
      logForDebugging(`thinking: step sealed (${reasoning.durationMs}ms), expanded until turn/end`)
    }
    reasoning = undefined
    if (activeAttempt !== undefined && activeAttempt.turn === event.turn && activeAttempt.step === event.step) activeAttempt = undefined
    updateSpinnerMode()
    const usage = event.usage
    if (usage !== undefined) {
      state.tokens.input += usage.input ?? 0
      state.tokens.output += usage.output ?? 0
      // Cache split totals feed the session cost estimate (hit-priced input
      // vs. uncached input) — the durable replay may lack them.
      state.tokens.cacheRead += usage.cacheRead ?? 0
      state.tokens.cacheWrite += usage.cacheWrite ?? 0
      // Rate-window bucketing by the request's own time (the durable replay
      // replays historical events, so a resumed session prices each request
      // at the rate window it actually ran in — the session cost estimate
      // never prices the whole session at the current window).
      const peak = (deps.pricingWindow?.(event.time) ?? 'idle') === 'peak'
      addUsageToBucket(peak ? state.tokens.peak : state.tokens.idle, usage)
      // 主会话费用分桶：计数方式与 tokens 相同，但按事件发生时的模型
      // 归属。replay 用 request.header 还原历史请求模型，旧日志回退
      // channel 模型；换模型不会把历史 token 重估到新模型。
      if ((usage.input ?? 0) !== 0 || (usage.output ?? 0) !== 0 || (usage.cacheRead ?? 0) !== 0 || (usage.cacheWrite ?? 0) !== 0) {
        const model = eventModel ?? state.model
        const cost = state.mainCost[model] ?? emptyCostBuckets()
        addUsageToBucket(peak ? cost.peak : cost.idle, usage)
        state.mainCost[model] = cost
      }
      // The most recent request's usage describes the current context:
      // input (uncached) + cache hits all occupy the window. Cache hits
      // also drive the status-line `cache N` readout.
      state.lastUsage = {
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        at: event.time,
      }
      // Turn ledger: each message reports its own request's increment, so
      // the sum is the turn total. Cache fields absent on the wire stay
      // absent (cacheKnown distinguishes zero from unreported).
      turnLedger.input += usage.input ?? 0
      turnLedger.output += usage.output ?? 0
      turnLedger.cacheRead += usage.cacheRead ?? 0
      turnLedger.cacheWrite += usage.cacheWrite ?? 0
      if (usage.cacheRead !== undefined || usage.cacheWrite !== undefined) turnLedger.cacheKnown = true
      turnLedger.usageSeen = true
      if (event.model !== undefined && event.model !== '') turnLedger.model = event.model
    }
    const tpsMessageStep = tpsStep
    if (
      tpsTurn === event.turn &&
      tpsMessageStep !== undefined &&
      tpsMessageStep.turn === event.turn &&
      tpsMessageStep.step === event.step &&
      tpsMessageStep.firstTokenTime !== undefined
    ) {
      const outputTokens = usageOutputTokens(usage)
        ?? (tpsMessageStep.outputChars > 0
          ? Math.ceil(tpsMessageStep.outputChars / 4)
          : undefined)
      if (outputTokens !== undefined) {
        tpsTurnDecodeMs += Math.max(0, event.time - tpsMessageStep.firstTokenTime)
        tpsTurnDecodeTokens += outputTokens
        tpsTurnSampled = true
        if (tpsTurnDecodeMs > 0) {
          state.tps = tpsTurnDecodeTokens / (tpsTurnDecodeMs / 1000)
        }
      }
    }
    if (
      tpsMessageStep !== undefined &&
      tpsMessageStep.turn === event.turn &&
      tpsMessageStep.step === event.step
    ) {
      tpsStep = undefined
    }
    // Context-bar segmentation (pi-nano-context style): assistant text and
    // tool calls in the assistant segment, thinking separately.
    for (const block of event.blocks) {
      if (block.type === 'text' && block.text) {
        state.contextSegments.assistant += estimateTokens(block.text)
      } else if (block.type === 'reasoning' && block.text) {
        state.contextSegments.thinking += estimateTokens(block.text)
      }
    }
  }

  const applyUserMessage = (event: AgentEventOf<'user.message'>): void => {
    // A compaction checkpoint renders as a folded summary rather than
    // disappearing with the other injected context.
    if (event.source === 'compaction') {
      const summary = event.text
      appendRow({ id: deps.rowIds.value, kind: 'notice', text: t('compact-done') })
      deps.rowIds.value += 1
      if (summary) {
        appendRow({ id: deps.rowIds.value, kind: 'compact', text: summary })
        deps.rowIds.value += 1
      }
      // The checkpoint replaces the whole pre-compact surface. Occupancy
      // needs no chars/4 rewrite here: a DSH host's token meter folds this
      // same event and reprices the surface by its logged shadow price (the
      // channel's `contextOccupancy` drops the moment the checkpoint lands),
      // and a backend that measures the compacted window reports it on
      // `compaction.end` (`postTokens`, below). `tokens.*` are cumulative
      // session counters and are never rewritten by a compaction.
      //
      // The segmented bar keeps its own heuristic composition (system + the
      // summary prompt): it describes what the surface is made of, never the
      // occupancy total.
      state.contextSegments = {
        system: state.contextSegments.system,
        prompt: estimateTokens(summary),
        assistant: 0,
        thinking: 0,
        tools: 0,
      }
      // The latch must release: compaction is the remediation for a low
      // context, so the warning has to be able to fire again afterwards.
      deps.resetContextWarning()
      return
    }
    // Command output a backend recorded as an input (Claude: `!!` output
    // sent on to the model): live, the channel already showed the command
    // and its output; a replay restores the output row.
    if (event.source === 'command-output') {
      if (replaying && event.text !== '') {
        appendRow({ id: deps.rowIds.value, kind: 'local-output', text: preview(event.text, LOCAL_OUTPUT_LIMIT), seq: event.seq })
        deps.rowIds.value += 1
      }
      return
    }
    // Injected context (plugin/skill/goal source) is not a human bubble;
    // v1 renders direct human prompts only.
    if (event.source !== 'user') return
    const text = event.text
    const images = event.images ?? NO_IMAGES
    if (text || images.length > 0) {
      // IDE selection indicator: the delivery path remembered what this
      // message attached; the durable event carries the same message id.
      // On replay (session resumed in a new process) the in-memory map
      // starts empty, so the indicator falls back to the durable content
      // itself: the `<attached-file … selection>` block is part of the
      // persisted message, so the indicator survives a restart.
      const selectionAttached = deps.selectionAttached(event.id)
        ?? replaySelectionAttachment(event.blocks)
      appendRow({
        id: deps.rowIds.value,
        kind: 'user',
        text,
        ...(images.length === 0 ? {} : { images }),
        ...(selectionAttached === undefined ? {} : { selectionAttached }),
        seq: event.seq,
        // A native anchor beyond the seq (DSH anchors are the seq, so DSH
        // rows carry none) is what a backend rewind needs.
        ...(event.anchor === '' || event.anchor === String(event.seq) ? {} : { anchor: event.anchor }),
      })
      state.lastUserText = text || t('transcript-image-message', { count: images.length })
      // The context estimate counts everything sent to the model: typed
      // text and the `@`-mention attachment blocks.
      state.contextSegments.prompt += estimateTokens(textOfBlocks(event.blocks))
      deps.rowIds.value += 1
    }
  }

  const applyToolCall = (event: AgentEventOf<'tool.call'>): void => {
    const presentation = event.presentation
    // A question-presented call renders as the interactive questionnaire
    // panel, not as a tool card: the model is parked waiting for the human,
    // so no running card, no active-tool spinner, no args noise in the
    // transcript. Only the arguments are remembered: the paired result
    // projects the answered record from them (issue #1009), so `/resume`,
    // rewind and replay rebuild it from the persisted log like every other
    // transcript row.
    if (presentation?.card === 'question') {
      askCalls.set(event.callId, event.argsJson)
      return
    }
    // A subagent delegation renders as the live subagent card (Kimi Code
    // semantics), so the raw args/result card would only duplicate it. The
    // call still runs; only its transcript rendering is suppressed. The
    // subagent reducer owns pending descriptions, including delegations made
    // while this transcript is parked.
    if (presentation?.card === 'subagent') return
    // A todo-list write renders in the todo panel (the backend emits
    // `todo.write` with it); a card would repeat the list. The call is
    // remembered so its result can still surface a failure card.
    if (presentation?.card === 'todo') {
      todoCalls.set(event.callId, { name: event.name, argsJson: event.argsJson, seq: event.seq, time: event.time })
      return
    }
    // Reasoning that led to a tool call is done thinking: fold the preview
    // now, before the tool card grows the transcript past it (see
    // settleLiveReasoning).
    settleLiveReasoning('tool call')
    const card: ChatRow = {
      id: deps.rowIds.value,
      kind: 'tool',
      text: '',
      seq: event.seq,
      // Smooth-reveal participation flag: live cards animate their body in;
      // replayed cards (resume/rewind) paint complete.
      fresh: !replaying,
      tool: {
        callId: event.callId,
        name: event.name,
        argsText: preview(event.argsJson, ARGS_PREVIEW_LIMIT),
        argsFull: event.argsJson,
        status: 'running',
        callView: presentation as ToolCallView | undefined,
        startedAt: Date.now(),
      },
    }
    deps.rowIds.value += 1
    toolCards.set(event.callId, card)
    appendRow(card)
    state.activeToolCount += 1
    state.contextSegments.assistant += estimateTokens(
      `${event.name}${event.argsJson}`,
    )
    updateSpinnerMode()
  }

  const applyToolResult = (event: AgentEventOf<'tool.result'>): void => {
    const callId = event.callId
    const card = toolCards.get(callId)
    const askArguments = askCalls.get(callId)
    // A call with no card is usually a question-presented one (above). Its
    // interaction lives in the panel, but its outcome still belongs in the
    // transcript, projected from the durable log here: consumed before the
    // card branch so the two can never both fire, and deleted so a repeated
    // replay of the same result cannot double the record.
    if (card === undefined && askArguments !== undefined) {
      projectAskResult(event, askArguments)
      askCalls.delete(callId)
      return
    }
    const suppressedTodo = todoCalls.get(callId)
    if (suppressedTodo !== undefined) {
      todoCalls.delete(callId)
      // Success stays in the panel; only a failure needs a visible card.
      if (event.isError) {
        settleLiveReasoning('tool call')
        const errorCard: ChatRow = {
          id: deps.rowIds.value,
          kind: 'tool',
          text: '',
          seq: suppressedTodo.seq,
          fresh: !replaying,
          tool: {
            callId,
            name: suppressedTodo.name,
            argsText: preview(suppressedTodo.argsJson, ARGS_PREVIEW_LIMIT),
            argsFull: suppressedTodo.argsJson,
            status: 'error',
            callView: undefined,
            startedAt: suppressedTodo.time,
            errorText: event.errorText ?? '',
          },
        }
        deps.rowIds.value += 1
        appendRow(errorCard)
        state.contextSegments.tools += estimateTokens(event.errorText ?? '')
      }
      return
    }
    if (card === undefined || card.tool === undefined) return
    const images = event.images ?? NO_IMAGES
    card.images = images.length === 0 ? undefined : images
    card.tool.durationMs = Math.max(0, Date.now() - card.tool.startedAt)
    if (event.isError) {
      card.tool.status = 'error'
      const errorText = event.errorText ?? ''
      card.tool.errorText = errorText
      state.contextSegments.tools += estimateTokens(errorText)
    } else {
      card.tool.status = 'ok'
      const result = event.text
      card.tool.resultText = result ? preview(result, RESULT_PREVIEW_LIMIT) : undefined
      // A card the window cap already folded while it ran keeps only its
      // preview: foldRows drops the full payload and the presentation views
      // by design (the durable record re-derives them on loadOlder), so a
      // late result must not re-attach them past the fold line.
      if (card.folded !== true) {
        card.tool.resultFull = result || undefined
        // The tool's own settled-state view (applied diff, terminal output,
        // read content…) wins over the raw text body.
        card.tool.resultView = event.presentation
      }
      state.contextSegments.tools += estimateTokens(result)
      settledCardCallId = callId
    }
    state.activeToolCount = Math.max(0, state.activeToolCount - 1)
    // The card is settled: no later event looks it up by callId, so drop the
    // index entry. The card itself stays in state.rows (bounded by MAX_ROWS +
    // foldRows, which also drops the full args/result payloads of folded
    // cards).
    toolCards.delete(callId)
    touchRow(card)
    updateSpinnerMode()
  }

  /** A task feed derived from one tool result reaches the job registry only
   *  when that result settled an ok card here (see settledCardCallId). */
  const taskFeedAdmitted = (callId: string | undefined): boolean =>
    callId === undefined || callId === settledCardCallId

  const applyTurnEnd = (event: AgentEventOf<'turn.end'>): void => {
    // A backend-reported session cost (cumulative, e.g. Claude
    // `total_cost_usd`) replaces the previous report; DSH reports none.
    if (event.cost !== undefined) state.costReport = event.cost
    if (activeAttempt !== undefined) discardAttempt(activeAttempt.turn, activeAttempt.step)
    openStep = undefined
    deps.inputConvergence.cancelInFlight = false
    state.cancelPending = false
    settleStreaming()
    state.working = false
    state.activeToolCount = 0
    if (tpsTurn !== undefined && tpsTurn === event.turn) {
      if (tpsTurnSampled && tpsTurnDecodeMs > 0) {
        const turnTps = tpsTurnDecodeTokens / (tpsTurnDecodeMs / 1000)
        state.tps = turnTps
        state.tpsSamples.push({ tps: turnTps, at: event.time })
        if (state.tpsSamples.length > 500) state.tpsSamples.shift()
      } else {
        // Do not leave a chars/4 live estimate behind when no completed
        // decode sample exists for this turn.
        state.tps = tpsBeforeTurn
      }
      tpsTurn = undefined
      tpsStep = undefined
      tpsTurnDecodeMs = 0
      tpsTurnDecodeTokens = 0
      tpsTurnSampled = false
    }
    // Occupancy is evaluated on every turn end, not only a completed one:
    // the request that overflowed the window is exactly the one whose turn
    // ends as an error (it writes no successful usage sample at all), and an
    // aborted turn has still grown the surface. Replay drains a resumed
    // session's history through the projector; its totals describe the past,
    // not a live context-low state.
    if (!replaying) deps.checkContextWarning()
    const reason = event.reason
    // Turn ledger → summary row + footer snapshot. Rendered as the turn's
    // last row (after the interrupt/notice that closes it), so the ledger
    // reads as the account of what just happened. A turn with no
    // usage-bearing message emits nothing (nothing was measured), and a
    // fully successful zero-usage turn stays quiet too.
    const outcome: 'completed' | 'interrupted' | 'error' =
      reason.kind === 'completed' ? 'completed'
        : reason.kind === 'aborted' || reason.kind === 'interrupted' ? 'interrupted'
          : 'error'
    const emitTurnSummary = (): void => {
      if (!turnLedger.usageSeen) return
      const total = turnLedger.input + turnLedger.output + turnLedger.cacheRead + turnLedger.cacheWrite
      if (outcome === 'completed' && total === 0 && turnFailedAttempts.size === 0) return
      const summary: TurnUsageSummary = {
        input: turnLedger.input,
        output: turnLedger.output,
        cacheRead: turnLedger.cacheRead,
        cacheWrite: turnLedger.cacheWrite,
        cacheKnown: turnLedger.cacheKnown,
        retries: turnFailedAttempts.size,
        durationMs: Math.max(0, event.time - turnLedger.startedAt),
        ...(turnLedger.model === undefined ? {} : { model: turnLedger.model }),
        ...(turnLedger.model === undefined || turnLedger.model === lastNotedTurnModel ? {} : { noteModel: true }),
        ...(state.reasoningEffort === undefined ? {} : { effort: state.reasoningEffort }),
        outcome,
      }
      if (turnLedger.model !== undefined) lastNotedTurnModel = turnLedger.model
      state.turnUsage = summary
      appendRow({ id: deps.rowIds.value, kind: 'turn-summary', text: '', turnUsage: summary })
      deps.rowIds.value += 1
    }
    if (reason.kind === 'completed') {
      emitTurnSummary()
      return
    }
    if (reason.kind === 'aborted' || reason.kind === 'interrupted') {
      // A user cancel closes the turn as `aborted`; `interrupted` only
      // appears for crash-orphaned turns. Both user-interruption paths
      // render as a distinct dim row.
      appendRow({
        id: deps.rowIds.value,
        kind: 'interrupt',
        text: t('interrupted-by-user') + t('interrupted-ask-next'),
      })
      deps.rowIds.value += 1
      emitTurnSummary()
      return
    }
    // The notice renders as a single-line Divider title: the error message
    // can carry newlines/control chars, and an embedded \n splits the rule
    // across rows. cleanRenderText is the render-path single-line contract
    // (sessionTree's preview() folds likewise for the tree).
    const label = reason.kind === 'other' ? reason.label : reason.kind
    const detail = reason.kind === 'error' ? cleanRenderText(reason.message, NOTICE_CELLS) : ''
    appendRow({ id: deps.rowIds.value, kind: 'notice', text: `turn ${label}${detail ? ` · ${detail}` : ''}` })
    deps.rowIds.value += 1
    emitTurnSummary()
    // Historical failure notices belong to the transcript row above;
    // re-raising them as a live toast on every /resume re-alarms the user
    // over a turn that already ended.
    if (!replaying) deps.notify(
      t('turn-failed', { detail: detail ? ` · ${detail}` : '' }),
      { color: 'error', timeoutMs: 8000 },
    )
  }

  const applyEvent = (event: AgentEvent): void => {
    // The trajectory fold sees every event before the lane split: a child's
    // lifecycle row belongs to the parent's ledger even though its
    // assistant/tool traffic is skipped inside the fold (child lane).
    deps.trajectory?.observe(event, replaying)
    // A subagent's own lane (its assistant and tool traffic) belongs to its
    // card and panels, never to the main transcript.
    if (laneOf(event) !== undefined) {
      deps.activity?.apply(event, replaying)
      return
    }
    switch (event.type) {
      case 'goal.change':
        if (event.operation === 'round') {
          // Admitted continuation round — the snapshot itself is unchanged.
          if (state.goal !== undefined && event.round !== undefined) {
            state.goal = {
              ...state.goal,
              roundsStarted: Math.max(state.goal.roundsStarted, event.round),
            }
          }
          return
        }
        applyGoalChange(event.operation, event.goal, event.roundsStarted)
        return
      case 'user.message':
        applyUserMessage(event)
        return
      case 'step.start':
        openStep = { turn: event.turn, step: event.step }
        if (tpsTurn === event.turn) {
          tpsStep = {
            turn: event.turn,
            step: event.step,
            firstTokenTime: undefined,
            outputChars: 0,
          }
        }
        return
      case 'step.end':
        if (openStep !== undefined && openStep.turn === event.turn && openStep.step === event.step) openStep = undefined
        if (
          tpsStep !== undefined &&
          tpsStep.turn === event.turn &&
          tpsStep.step === event.step
        ) {
          tpsStep = undefined
        }
        return
      case 'assistant.attempt.start':
        // Start owns the attempt's (turn, step); a superseded attempt that
        // never settled loses its provisional rows.
        if (activeAttempt !== undefined) {
          // Capture before discardAttempt: clearing the superseded attempt's
          // rows also clears the `activeAttempt` ref itself (its last line).
          const superseded = activeAttempt.attemptId
          discardAttempt(activeAttempt.turn, activeAttempt.step)
          // The superseded attempt failed mid-flight (an API retry opens the
          // replacement): it counts toward the turn's retry tally.
          turnFailedAttempts.add(superseded)
        }
        activeAttempt = { attemptId: event.attemptId, turn: event.turn, step: event.step }
        return
      case 'assistant.attempt.end':
        // A positioned end is a durable record of a failed attempt: drop that
        // step's provisional rows whether or not a live attempt matched.
        if (event.turn !== undefined && event.step !== undefined) {
          if (event.outcome !== 'committed') turnFailedAttempts.add(event.attemptId)
          discardAttempt(event.turn, event.step)
          return
        }
        // Settlement owns the text; an abandoned end must discard provisional
        // rows even when no durable event was written.
        if (activeAttempt?.attemptId !== event.attemptId) return
        if (event.outcome !== 'committed') {
          turnFailedAttempts.add(activeAttempt.attemptId)
          discardAttempt(activeAttempt.turn, activeAttempt.step)
        }
        activeAttempt = undefined
        return
      case 'assistant.delta':
        if (event.seq !== undefined) {
          // Positioned legacy delta: its own durable (turn, step), deduplicated
          // by seq (a reconnect may replay the same durable chunk).
          if (handledAssistantChunks.has(event.seq)) return
          handledAssistantChunks.add(event.seq)
          renderStreamDelta(event.turn as number, event.step as number, event.delta, event.time, event.seq)
          return
        }
        // A reattach rebuilds the attempt's (turn, step) from the open
        // durable step when its start was missed.
        if (activeAttempt === undefined && openStep !== undefined) {
          activeAttempt = { attemptId: event.attemptId, ...openStep }
        }
        if (activeAttempt?.attemptId !== event.attemptId) return
        renderStreamDelta(activeAttempt.turn, activeAttempt.step, event.delta, event.time)
        return
      case 'assistant.message':
        applyAssistantMessage(event)
        return
      case 'tool.call':
        applyToolCall(event)
        return
      case 'tool.result':
        applyToolResult(event)
        return
      case 'task.output':
        // A `job_output`-style read doubles as the job card's output feed:
        // the registry's read is consuming and reserved for the owning
        // agent, so the UI mirrors the tail that already streams through
        // the transcript instead of polling the job itself.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack a time
        if (taskFeedAdmitted(event.callId)) deps.jobs.onOutputSeen(event.taskId, event.text, event.time ?? Date.now())
        deps.activity?.apply(event, replaying)
        return
      case 'task.start':
        // A background-start ack pairs the job with its tool call and gives
        // the full command (the registry label is the friendly description).
        if (event.command !== undefined && taskFeedAdmitted(event.callId)) deps.jobs.onStarted(event.taskId, event.command)
        deps.activity?.apply(event, replaying)
        return
      case 'subagent.start':
      case 'subagent.progress':
      case 'subagent.end':
      case 'task.update':
      case 'task.end':
      case 'tasks.snapshot':
        deps.activity?.apply(event, replaying)
        return
      case 'turn.start':
        deps.inputConvergence.cancelInFlight = false
        state.cancelPending = false
        state.working = true
        state.turnStart = Date.now()
        state.responseChars = 0
        state.spinnerMode = 'requesting'
        // Fresh turn ledger: the previous turn's summary stays on
        // `state.turnUsage` (the footer reads it) while this one accrues.
        turnLedger.input = 0
        turnLedger.output = 0
        turnLedger.cacheRead = 0
        turnLedger.cacheWrite = 0
        turnLedger.cacheKnown = false
        turnLedger.usageSeen = false
        turnLedger.startedAt = event.time
        turnLedger.model = undefined
        turnFailedAttempts.clear()
        // Keep the prior turn visible until this turn produces a measurable
        // decode span, while starting a fresh weighted step fold.
        tpsBeforeTurn = state.tps
        tpsTurn = event.turn
        tpsTurnDecodeMs = 0
        tpsTurnDecodeTokens = 0
        tpsTurnSampled = false
        tpsStep = undefined
        return
      case 'turn.end':
        applyTurnEnd(event)
        // A foreground subagent cannot outlive its turn (./activity.ts).
        deps.activity?.apply(event, replaying)
        return
      case 'context.capacity':
        // Backend-advertised context capacity; drives the context-low warning.
        state.contextWindow = event.contextWindow
        return
      case 'session.ready':
        // The backend's own account of the session it opened: the model it
        // actually runs (status line) and its context window when known.
        if (event.model !== '') state.model = event.model
        if (event.contextWindow !== undefined) state.contextWindow = event.contextWindow
        return
      case 'model.changed':
        if (event.model !== '') state.model = event.model
        return
      case 'system.prompt':
        // The latest system prompt holds the active instructions (an empty
        // render clears them); the context bar's system segment tracks it.
        state.contextSegments.system = estimateTokens(event.text)
        return
      case 'request.header':
        // Reasoning effort readout (status line) from the call config.
        if (event.effort !== undefined) state.reasoningEffort = event.effort
        // 该请求的 usage 按这里的 model 计价（replay 时逐请求还原；live 时
        // 与 state.model 同步更新）。header 缺/空 model 时也要清掉上一条
        // header 的值，否则后续 usage 会沿用旧模型进错桶；归属时再回退
        // state.model（旧日志没有 header 时就是这样）。
        eventModel = event.model
        return
      case 'session.title':
        state.sessionTitle = event.title
        return
      case 'session.color':
        // `/color` accent, replayed on resume/rewind like the title: last
        // write wins, '' clears to the default.
        state.sessionColor = event.color
        return
      case 'todo.write':
        // The snapshot array is adopted as-is (the durable record owns it).
        state.todos = event.items as TodoPanelItem[]
        return
      case 'preset.selected': {
        // A transcript marker so a replayed log shows which composition
        // produced the turns after it. A recording under an alias of the
        // current preset shows the current spelling.
        const current = state.agentPreset
        // `aliases` crosses a backend boundary: only a real array is trusted
        // (a translator bug must not turn a marker into a projector throw).
        const aliases: unknown = event.aliases
        const preset = current !== undefined && Array.isArray(aliases) && aliases.includes(current) ? current : event.preset
        appendRow({
          id: deps.rowIds.value,
          kind: 'notice',
          text: t('agent-preset-switched', { preset }),
        })
        deps.rowIds.value += 1
        return
      }
      case 'compaction.start':
        // Opening the bracket here rather than in the manual path is what
        // makes an automatic pressure compaction visible too. A manual
        // request already installed its own cancellable row, so this only
        // fills the gap for one this process did not start. Replay is settled
        // history, and a process killed between start and end leaves an
        // unmatched start in the log: painting a row for it would show a
        // compaction that nothing will ever clear.
        if (!replaying && state.compaction === undefined) {
          state.compaction = {
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack a time
            startedAt: typeof event.time === 'number' ? event.time : Date.now(),
            phase: 'prefill',
            outputChars: 0,
            cancellable: event.cancellable,
          }
        }
        return
      case 'compaction.progress': {
        const compaction = state.compaction
        if (compaction !== undefined) {
          state.compaction = {
            ...compaction,
            phase: 'summary',
            outputChars: compaction.outputChars + event.outputChars,
          }
        }
        return
      }
      case 'compaction.end':
        state.compaction = undefined
        // A backend that measured the compacted window (Claude
        // `compact_boundary.post_tokens`) re-seeds the occupancy sample with
        // it: a compaction turn makes no request, so without this the
        // fallback reading would keep the pre-compact size until the next
        // turn. DSH reports no `postTokens` (its token meter owns occupancy).
        if (event.ok && event.postTokens !== undefined) {
          state.lastUsage = { input: event.postTokens, output: 0, cacheRead: 0, cacheWrite: 0, at: event.time }
        }
        return
      case 'custom': {
        // Custom plugin events (tuiRenderers seam): a registered renderer maps
        // the payload to text rows: title as a local row, body as
        // preview-clipped local-output rows, same shape pushLocal uses. Runs
        // on the live stream and on replay (resume/rewind), so the projection
        // must stay total; the runtime isolates renderer crashes per type.
        if (deps.renderer === undefined) return
        const rendered = deps.renderer.render(event.nativeType, event.data)
        if (rendered === undefined) return
        if (rendered.title !== undefined && rendered.title !== '') {
          appendRow({ id: deps.rowIds.value, kind: 'local', text: rendered.title })
          deps.rowIds.value += 1
        }
        for (const line of rendered.lines) {
          appendRow({
            id: deps.rowIds.value,
            kind: 'local-output',
            text: preview(String(line), LOCAL_OUTPUT_LIMIT),
          })
          deps.rowIds.value += 1
        }
        return
      }
      case 'notice': {
        // A backend notice: `info` is a transcript fact (a dim notice row);
        // `notice` is a passing toast; `warning`/`error` are both: the row
        // keeps the explanation next to the work it concerns, the toast makes
        // sure it is seen. Replay repaints rows only, never toasts.
        //
        // A `key` dedupes repeats of one condition (an API retry counting
        // up, a limit warning): its toast replaces the key's previous toast,
        // and its row is updated in place while that row is still the last
        // one (once other rows follow, a new row keeps the history in order).
        const text = cleanRenderText(event.text, NOTICE_CELLS)
        if (text === '') return
        if (event.level !== 'notice') {
          const last = state.rows.at(-1)
          if (event.key !== undefined && keyedNoticeRow?.key === event.key && last !== undefined && last === keyedNoticeRow.row) {
            last.text = text
            touchRow(last)
          } else {
            const row: ChatRow = { id: deps.rowIds.value, kind: 'notice', text }
            appendRow(row)
            deps.rowIds.value += 1
            keyedNoticeRow = event.key === undefined ? undefined : { key: event.key, row }
          }
        }
        if (!replaying && event.level !== 'info') {
          if (event.key !== undefined) keyedToasts.get(event.key)?.()
          const dismiss = deps.notify(text, event.level === 'notice' ? { timeoutMs: 4000 } : { color: event.level, timeoutMs: 8000 })
          if (event.key !== undefined) {
            keyedToasts.delete(event.key)
            keyedToasts.set(event.key, dismiss)
            // Bounded: keys are per condition (a call, a tool use).
            for (const stale of keyedToasts.keys()) {
              if (keyedToasts.size <= MAX_KEYED_TOASTS) break
              keyedToasts.delete(stale)
            }
          }
        }
        return
      }
      // Owned outside the transcript reducer: session status and pending
      // inputs by the channel binding, permissions/questions by their stores,
      // and agent-message observations by the activity projection.
      case 'agent.message':
        deps.activity?.apply(event, replaying)
        return
      case 'session.reset':
      case 'session.status':
      case 'pending.changed':
      case 'tool.progress':
      case 'permission.request':
      case 'permission.settled':
      case 'question.request':
      case 'question.settled':
      case 'context.usage':
      case 'effort.changed':
      case 'mode.changed':
      case 'commands.changed':
      case 'rate-limit':
        return
      default: {
        // Exhaustiveness: a new AgentEvent variant must be handled above.
        const unhandled: never = event
        void unhandled
      }
    }
  }

  /**
   * Fold one batch. A `replay` batch is one complete history pass: sequence
   * numbers restart with a replacement session, so the idempotency ledgers
   * and step/attempt bindings reset before it (an old session must not
   * suppress a legitimate message in the new transcript), and it paints
   * settled history (no live toasts, no smooth reveal, no unmatched
   * compaction row).
   */
  const apply = (events: readonly AgentEvent[], meta: AgentEventMeta): void => {
    if (!meta.replay) {
      for (const event of events) applyEvent(event)
      return
    }
    handledAssistantMessages.clear()
    handledAssistantChunks.clear()
    openStep = undefined
    activeAttempt = undefined
    eventModel = undefined
    assistantRowsByStep.clear()
    lastTextDelta.clear()
    // Rows still on screen when a replay starts keep matching by seq, so a
    // replay over painted history reuses them instead of duplicating them.
    assistantRowsBySeq.clear()
    for (const row of state.rows) if (row.kind === 'assistant') indexAssistantRow(row)
    replaying = true
    try {
      for (const event of events) applyEvent(event)
    } finally {
      replaying = false
    }
  }

  /** Forget every per-session projection ledger (adoption, `/clear`). */
  function reset(): void {
    keyedNoticeRow = undefined
    streaming = undefined
    reasoning = undefined
    sealedReasoning.length = 0
    lastReasoningRow = undefined
    toolCards.clear()
    askCalls.clear()
    todoCalls.clear()
    settledCardCallId = undefined
    handledAssistantMessages.clear()
    handledAssistantChunks.clear()
    openStep = undefined
    activeAttempt = undefined
    eventModel = undefined
    assistantRowsByStep.clear()
    assistantRowsBySeq.clear()
    lastTextDelta.clear()
    lastNotedTurnModel = undefined
    tpsTurn = undefined
    tpsStep = undefined
    tpsTurnDecodeMs = 0
    tpsTurnDecodeTokens = 0
    tpsTurnSampled = false
  }
  return { apply, reset, settleStreaming, updateSpinnerMode }
}

export type ChannelProjection = ReturnType<typeof createChannelProjection>
