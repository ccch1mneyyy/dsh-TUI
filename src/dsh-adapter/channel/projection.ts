import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ChannelState, ChannelGoal, ChatRow, ToolCallView, ToolResultView, ToolsRegistryLike } from './types.js'
import type { InputConvergence } from './input-actions.js'
import type { BackgroundJobStore } from '../jobs.js'
import type { TuiRendererHost } from '../renderers.js'
import { isSubagentToolName, parseJobOutputId, toolCommandOf, BACKGROUND_START_ACK, todoPanelItems } from './projection-helpers.js'
import { ARGS_PREVIEW_LIMIT, harnessToolResultView, LOCAL_OUTPUT_LIMIT, prepareReplayEvents, preview, RESULT_PREVIEW_LIMIT, toolErrorText } from './transcript.js'
import { estimateTokens, isTokenDelta, tokenDeltaChars, usageOutputTokens } from './usage.js'
import { transcriptImagesOf, type TranscriptImage } from '../transcript-images.js'
import { isPeakHour } from '../../deepseekPricing.js'
import { t } from '../../i18n.js'
import { logForDebugging } from '../../utils/debug.js'
import { cleanRenderText } from '../sanitize.js'
import { NOTICE_CELLS } from './decisions.js'
import { markChannelReadDirty } from '../../adapter/channel/read-view.js'

type ProjectionState = Pick<ChannelState, 'rows' | 'thinkingFold' | 'activeToolCount' | 'spinnerMode' | 'goal' | 'contextSegments' | 'tokens' | 'lastUsage' | 'lastUserText' | 'responseChars' | 'tps' | 'cancelPending' | 'working' | 'turnStart' | 'tpsSamples' | 'contextWindow' | 'reasoningEffort' | 'sessionTitle' | 'todos' | 'agentPreset' | 'sessionColor' | 'status' | 'emit'>
interface ProjectionDependencies {
 agent(): Agent
 rowIds: { value: number }
 resetContextWarning(): void
 pendingTaskDescriptions: string[]
 jobs: Pick<BackgroundJobStore, 'onOutputSeen' | 'onStarted'>
 inputConvergence: Pick<InputConvergence, 'cancelInFlight'>
 checkContextWarning(): void
 notify: ChannelState['notify']
 tools?: ToolsRegistryLike
 renderer?: TuiRendererHost
 /** DSH attachment service, resolved at call time (a late-mounted provider
  *  must still serve images for rows projected earlier). */
 attachments(): unknown
}
/** One authoritative reducer for both durable replay and live session events. */
export function createChannelProjection(state: ProjectionState, deps: ProjectionDependencies) {
  /** The in-progress assistant text row; `undefined` when no step is streaming. */
  let streaming: ChatRow | undefined
  /** The in-progress reasoning row; `undefined` when no reasoning is streaming. */
  let reasoning: ChatRow | undefined
  /** Reasoning rows sealed by an assistant/message this turn. They stay
   *  `streaming: true` — expanded in the transcript — until turn/end folds
   *  them (WebUI AssistantMarkdown keepOpen parity: thinking holds open
   *  through the whole in-flight turn, tool-call steps included). */
  const sealedReasoning: ChatRow[] = []
  /** Wall-clock start of the current reasoning row (durationMs on settle). */
  let reasoningStart = 0
  /** Decode-throughput fold for the current turn. DSH defines one step as
   *  one model call plus its tools; summing only first-token → message spans
   *  excludes tool execution and per-request TTFT from generation speed. */
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
  /** Tool cards by callId, so tool/result can settle the running card. */
  const toolCards = new Map<string, ChatRow>()
  /**
   * Session events are delivered live and can also be replayed around a
   * reconnect. A repeated sealed message must not create a second assistant
   * row for the same durable sequence number.
   */
  const handledAssistantMessages = new Set<number>()
  const handledAssistantChunks = new Set<number>()
  const assistantRowsByStep = new Map<string, ChatRow>()
  const lastTextDelta = new Map<ChatRow, string>()
  const stepKey = (turn: number, step: number): string => `${turn}:${step}`
  const touchRow = (row: ChatRow): void => { markChannelReadDirty(row); markChannelReadDirty(state.rows) }
  const appendRow = (row: ChatRow): void => { state.rows.push(row); markChannelReadDirty(state.rows) }

  /** Durable session image blocks, loaded lazily through the attachment
   *  store. Projection never reads pixels; the UI decodes on demand. */
  const transcriptImages = (content: readonly ContentBlock[] | undefined): readonly TranscriptImage[] =>
    transcriptImagesOf(content, deps.attachments)

  /** Append a stream delta idempotently. Providers normally send a pure
   * delta, but reconnect/proxy paths can resend a cumulative prefix or a
   * delta whose beginning overlaps the previous tail. Merge the overlap
   * instead of blindly concatenating it into the visible transcript. */
  const appendTextDelta = (row: ChatRow, delta: string): void => {
    if (delta === '') return
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

  /** The host-plane tools registry (dsh-tools). Resolved once; absent in
   *  bare embedders — every presenter call soft-fails to undefined and the
   *  card falls back to raw text. */
  const toolsRegistry = deps.tools
  /** Ask the producing tool how its call should render (diff/terminal/…).
   *  Scoped to the live agent so preset-owned tool definitions resolve —
   *  the dsh-host-apiproxy presenter pattern. Unknown tool, unparseable
   *  args, or a throwing presenter all degrade to the plain text card. */
  const presentCallView = (name: string, rawArgs: string): ToolCallView | undefined => {
    try {
      const tool = toolsRegistry?.get(name, deps.agent())
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
      // Harness goal/todo tools first: their raw JSON reads as noise in the
      // transcript — fold recognizable shapes into a summary card before the
      // registry gets a chance to (not) know them.
      const local = harnessToolResultView(name, data)
      if (local !== undefined) return local
      const tool = toolsRegistry?.get(name, deps.agent())
      if (tool?.presentResult === undefined) return undefined
      const block = data.message.content[0]
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable session data may not match type
      const content = block !== undefined && block.type === 'tool-result' ? block.content : []
      return tool.presentResult(JSON.parse(rawArgs), {
        content,
        isError: block?.isError === true,
        ...(data.meta !== undefined ? { meta: data.meta } : {}),
      }) as ToolResultView | undefined
    } catch {
      return undefined
    }
  }

  // ContentBlockMap is merge-extensible: plugin-added block types are
  // silently skipped (v1 renders text blocks only) — never crashes.
  const textOf = (content: readonly ContentBlock[] | undefined): string =>
    (content ?? []).map(block => (block.type === 'text' ? block.text : '')).join('').trim()

  /**
   * Transcript-facing text of a user message: the FIRST text block only.
   * `@`-mention attachments (issue #15) ride as later blocks — model-facing
   * only — so joining every block would dump file contents into the bubble,
   * the sticky header, and session titles.
   */
  const firstTextOf = (content: readonly ContentBlock[] | undefined): string =>
    (content ?? []).find(block => block.type === 'text')?.text.trim() ?? ''

  const ensureStreaming = (seq?: number): ChatRow => {
    if (streaming !== undefined) return streaming
    // A reconnect can replay the first delta after the sealed message was
    // already observed. Reuse that durable row instead of opening a second
    // assistant bubble for the same event sequence.
    const existing = seq === undefined
      ? undefined
      : [...state.rows].reverse().find(row => row.kind === 'assistant' && row.seq === seq)
    if (existing !== undefined) {
      existing.streaming = true
      touchRow(existing)
      streaming = existing
      return existing
    }
    streaming = { id: deps.rowIds.value, kind: 'assistant', text: '', streaming: true, fresh: true, ...seq !== undefined ? { seq } : {} }
    deps.rowIds.value += 1
    appendRow(streaming)
    return streaming
  }

  /** Latest reasoning row keyed by its (turn, step) — lets a resumed
   *  mid-step stream REVIVE the row the replay sealed (crash-orphan tail:
   *  replay folds the partial row, live continuation chunks would
   *  otherwise open a SECOND row for the same step, splitting one
   *  thinking block in two). */
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

  /** Fold the live reasoning preview the moment the model moves PAST
   *  thinking — the answer's first text token or a tool call — not at
   *  `assistant/message` (end of step). A long reply pushes the thinking
   *  block into terminal scrollback long before the message seals, and
   *  scrollback rows cannot be repainted (the cursor cannot reach them),
   *  so a late fold leaves a stale unfolded preview frozen above the
   *  window — the user scrolls up and the thinking looks "not folded".
   *  Folding while the block still sits in the live window keeps the
   *  shrink inside the diff engine's reachable region. Preview mode only
   *  (`full` holds every block open until turn settle by design). */
  const foldLiveReasoning = (where: string): void => {
    if (reasoning === undefined || state.thinkingFold !== 'preview') return
    const duration = Math.max(0, Date.now() - reasoningStart)
    reasoning.durationMs = duration
    reasoning.streaming = false
    touchRow(reasoning)
    sealedReasoning.push(reasoning)
    reasoning = undefined
    logForDebugging(`thinking: folded at ${where} (${duration}ms)`)
  }

  const settleStreaming = (): void => {
    if (streaming !== undefined) { streaming.streaming = false; touchRow(streaming) }
    streaming = undefined
    const folded = sealedReasoning.length + (reasoning !== undefined ? 1 : 0)
    for (const row of sealedReasoning) { row.streaming = false; touchRow(row) }
    sealedReasoning.length = 0
    if (reasoning !== undefined) {
      reasoning.streaming = false
      reasoning.durationMs = Math.max(0, Date.now() - reasoningStart)
      touchRow(reasoning)
    }
    reasoning = undefined
    if (folded > 0) logForDebugging(`thinking: folded ${folded} reasoning row(s) at turn settle`)
  }

  /** Recompute the spinner phase from live row/tool state. */
  const updateSpinnerMode = (): void => {
    if (state.activeToolCount > 0) {
      state.spinnerMode = 'tool-use'
    } else if (reasoning !== undefined) {
      // Only LIVE reasoning counts — sealed rows stay streaming=true for
      // transcript expansion until turn/end but the model is past thinking.
      state.spinnerMode = 'thinking'
    } else if (streaming !== undefined) {
      state.spinnerMode = 'responding'
    } else {
      state.spinnerMode = 'requesting'
    }
  }

  /**
   * One durable goal mutation as the goal service records it (the `data` of
   * a top-level `goal/change` session event, and of the snapshot a round-zero
   * goal-sourced `user/message` may inline). Declared structurally: the
   * pinned peer's `SessionEvent` union predates the event type, so the fold
   * admits the payload by shape, not by union membership.
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
    goal?: Omit<ChannelGoal, 'roundsStarted'>
    roundsStarted?: number
  }

  /** Fold one goal mutation into the channel's goal projection. */
  const applyGoalChange = (change: GoalChangePayload): void => {
    if (change.operation === 'clear') {
      state.goal = undefined
    } else if (change.goal !== undefined) {
      state.goal = {
        ...change.goal,
        roundsStarted: change.roundsStarted ?? state.goal?.roundsStarted ?? 0,
      }
    }
  }

  /**
   * Fold one goal-sourced message into the channel's goal projection.
   * Round-zero goal messages may carry the full durable snapshot (or a clear
   * tombstone) in their source; positive-round messages are admitted
   * continuation prompts that only advance the rounds counter.
   */
  const applyGoalEvent = (event: SessionEvent<'user/message'>): void => {
    const source = event.data.source as unknown as {
      round: number
      change?: GoalChangePayload
    }
    if (source.round > 0) {
      // Admitted continuation round — the snapshot itself is unchanged.
      if (state.goal !== undefined) {
        state.goal = {
          ...state.goal,
          roundsStarted: Math.max(state.goal.roundsStarted, source.round),
        }
      }
      return
    }
    const change = source.change
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may not match the static type
    if (change === undefined || change.kind !== 'goal/change') return
    applyGoalChange(change)
  }

  /** True while the durable transcript is being replayed (boot /resume /
   *  rewind / model-switch fork). The assistant/message reasoning-rebuild
   *  branch below must run ONLY on this path: in a live stream the chunks
   *  already created the reasoning row, and foldLiveReasoning clears the
   *  `reasoning` handle before assistant/message arrives — so
   *  `reasoning === undefined` alone cannot tell replay from live, and
   *  using it would rebuild a second thinking block per step. */
  let replaying = false
  const replayEvents = (events: readonly SessionEvent[]): void => {
    // Event sequence numbers restart with a replacement session; reset the
    // idempotency ledger before replay so an old session cannot suppress a
    // legitimate message in the new transcript.
    handledAssistantMessages.clear()
    handledAssistantChunks.clear()
    assistantRowsByStep.clear()
    lastTextDelta.clear()
    replaying = true
    try {
      for (const event of prepareReplayEvents(events)) renderEvent(event)
    } finally {
      replaying = false
    }
  }

  const renderEvent = (event: SessionEvent): void => {
    // Top-level `goal/change` events are how the goal service actually
    // records durable goal mutations (create/edit/pause/resume/complete/
    // block/clear) — confirmed in production logs. The pinned peer's
    // SessionEvent union predates the type, so admit it structurally: the
    // goal chip and panel stay dark without this fold.
    if ((event as { type: string }).type === 'goal/change') {
      applyGoalChange((event as { data: GoalChangePayload }).data)
      return
    }
    switch (event.type) {
      case 'user/message': {
        // Compaction checkpoint: `source = { kind: 'plugin', plugin:
        // 'compact' }` (dsh-compact's COMPACT_CHECKPOINT_SOURCE). CC shows
        // the framed summary after /compact; render it as a Divider title +
        // a summary row that defaults folded (`compact` kind) instead of
        // skipping it like other injected context.
        if (
          event.data.source.kind === 'plugin' &&
          event.data.source.plugin === 'compact'
        ) {
          const summary = textOf(event.data.content)
          appendRow({ id: deps.rowIds.value, kind: 'notice', text: 'Session summary is ready' })
          deps.rowIds.value += 1
          if (summary) {
            appendRow({ id: deps.rowIds.value, kind: 'compact', text: summary })
            deps.rowIds.value += 1
          }
          // The surface replace drops the whole pre-compact history: reset
          // the context accounting NOW so the status bar (ctx bar, tokens,
          // context-low warning) drops immediately instead of waiting for
          // the next request's usage event.
          const removed =
            state.contextSegments.prompt +
            state.contextSegments.assistant +
            state.contextSegments.thinking +
            state.contextSegments.tools
          const summaryTokens = estimateTokens(summary)
          state.tokens.input = Math.max(0, state.tokens.input - removed) + summaryTokens
          state.contextSegments = {
            system: state.contextSegments.system,
            prompt: summaryTokens,
            assistant: 0,
            thinking: 0,
            tools: 0,
          }
          state.lastUsage = {
            input: state.contextSegments.system + summaryTokens,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          }
          deps.resetContextWarning()
          break
        }
        // Same-session goal domain: goal-sourced messages are the round
        // driver's continuation prompts (positive rounds advance the
        // counter); some hosts also inline the durable snapshot in a
        // round-zero source. They are not transcript bubbles — they drive
        // the goal panel's live projection (replayed on resume/rewind like
        // every other event; the snapshot itself arrives as the top-level
        // `goal/change` event admitted above).
        if ((event.data.source as { kind: string }).kind === 'goal') {
          applyGoalEvent(event)
          break
        }
        // Injected context (plugin/skill source) is not a human bubble; v1
        // renders direct human prompts only.
        if (event.data.source.kind !== 'user') break
        const text = firstTextOf(event.data.content)
        const images = transcriptImages(event.data.content)
        if (text || images.length > 0) {
          appendRow({
            id: deps.rowIds.value,
            kind: 'user',
            text,
            ...(images.length === 0 ? {} : { images }),
            seq: event.seq,
          })
          state.lastUserText = text || t('transcript-image-message', { count: images.length })
          // The context estimate counts everything sent to the model —
          // typed text AND the `@`-mention attachment blocks.
          state.contextSegments.prompt += estimateTokens(textOf(event.data.content))
          deps.rowIds.value += 1
        }
        break
      }
      case 'step/start': {
        if (tpsTurn === event.data.turn) {
          tpsStep = {
            turn: event.data.turn,
            step: event.data.step,
            firstTokenTime: undefined,
            outputChars: 0,
          }
        }
        break
      }
      case 'assistant/chunk': {
        if (handledAssistantChunks.has(event.seq)) break
        handledAssistantChunks.add(event.seq)
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') {
          if (chunk.text) {
            // Fold the thinking preview while it is still in the live
            // window (see foldLiveReasoning) — before this text grows the
            // transcript and pushes the block into scrollback.
            foldLiveReasoning('first text token')
            const key = stepKey(event.data.turn, event.data.step)
            const row = assistantRowsByStep.get(key) ?? ensureStreaming(event.seq)
            assistantRowsByStep.set(key, row)
            streaming = row
            row.streaming = true
            touchRow(row)
            const before = row.text.length
            appendTextDelta(row, chunk.text)
            state.responseChars += Math.max(0, row.text.length - before)
          }
        } else if (chunk.type === 'reasoning-delta') {
          if (chunk.text) {
            const row = ensureReasoning(event.seq, event.data.turn, event.data.step)
            appendTextDelta(row, chunk.text)
          }
        }
        const step = tpsStep
        if (
          step !== undefined &&
          step.turn === event.data.turn &&
          step.step === event.data.step &&
          isTokenDelta(chunk)
        ) {
          step.firstTokenTime ??= event.time
          step.outputChars += tokenDeltaChars(chunk)
          const elapsedMs = Math.max(0, event.time - step.firstTokenTime)
          if (elapsedMs > 500) {
            const decodeMs = tpsTurnDecodeMs + elapsedMs
            const outputTokens = tpsTurnDecodeTokens + Math.ceil(step.outputChars / 4)
            state.tps = outputTokens / (decodeMs / 1000)
          }
        }
        updateSpinnerMode()
        break
      }
      case 'assistant/message': {
        if (handledAssistantMessages.has(event.seq)) break
        handledAssistantMessages.add(event.seq)
        const text = textOf(event.data.message.content)
        const images = transcriptImages(event.data.message.content)
        // Replay without chunk deltas (prepareReplayEvents drops settled
        // ones): rebuild the reasoning row from the sealed message's
        // reasoning blocks. Replay-only — gated on the `replaying` flag,
        // not on `reasoning === undefined`: a live stream's chunks already
        // created the row, and foldLiveReasoning has cleared the `reasoning`
        // handle by the time this event lands, so the undefined check alone
        // would rebuild a duplicate thinking block per step. Pushed BEFORE
        // the assistant row so the transcript order matches the live
        // stream; settled (folded) immediately, durationMs unknown without
        // a live clock.
        if (replaying && reasoning === undefined) {
          const reasoningText = event.data.message.content
            .map(block => (block.type === 'reasoning' ? block.text : ''))
            .join('')
          if (reasoningText !== '') {
            appendRow({
              id: deps.rowIds.value,
              kind: 'reasoning',
              text: reasoningText,
              seq: event.seq,
            })
            deps.rowIds.value += 1
          }
        }
        // Reasoning/tool-only steps emit no text: creating an assistant row
        // anyway leaves an empty `●` bullet in the transcript. A pre-existing
        // streaming row always has text (ensureStreaming is only reached on
        // non-empty text deltas), so only create one when text arrives.
        // Key the step→row ledger only when the event carries a durable
        // turn/step; a message without them must never collide onto a
        // previous step's row (a bare `undefined:undefined` key would make
        // every turn/step-less message reuse the FIRST one's assistant row).
        const msgTurn = event.data.turn
        const msgStep = event.data.step
        const msgKey = msgTurn !== undefined && msgStep !== undefined
          ? stepKey(msgTurn, msgStep)
          : undefined
        const row = (msgKey !== undefined ? assistantRowsByStep.get(msgKey) : undefined) ?? streaming ??
          (text || images.length > 0
            ? ([...state.rows].reverse().find(candidate =>
                candidate.kind === 'assistant' && candidate.seq === event.seq,
              ) ?? ensureStreaming(event.seq))
            : undefined)
        if (row !== undefined) {
          if (msgKey !== undefined) assistantRowsByStep.set(msgKey, row)
          row.time = event.time
          if (text) row.text = text
          row.images = images.length === 0 ? undefined : images
          row.streaming = false
          // Live settles keep the smooth-reveal cursor alive (a one-shot
          // non-streaming delivery still paints as a flow); replayed
          // settles must not — the transcript would typewrite on open.
          if (!replaying && text) row.fresh = true
          touchRow(row)
        }
        streaming = undefined
        if (reasoning !== undefined) {
          // Backstop fold: reasoning whose step ended with no text token
          // and no tool call (foldLiveReasoning handles those earlier —
          // while the block is still in the repaintable live window;
          // here a long reply may already have pushed it into scrollback,
          // where the shrink cannot be repainted). `full` mode
          // (/settings opt-in) keeps the block expanded until turn settle
          // — settleStreaming folds the sealed rows then.
          reasoning.durationMs = Math.max(0, Date.now() - reasoningStart)
          if (state.thinkingFold === 'preview') reasoning.streaming = false
          touchRow(reasoning)
          sealedReasoning.push(reasoning)
          logForDebugging(`thinking: step sealed (${reasoning.durationMs}ms), expanded until turn/end`)
        }
        reasoning = undefined
        updateSpinnerMode()
        const usage = event.data.usage
        if (usage !== undefined) {
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack tokens
          state.tokens.input += usage.inputTokens ?? 0
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack tokens
          state.tokens.output += usage.outputTokens ?? 0
          // Cache split totals feed the session cost estimate (hit-priced
          // input vs. uncached input) — the durable replay may lack them.
          state.tokens.cacheRead += usage.cacheReadTokens ?? 0
          state.tokens.cacheWrite += usage.cacheWriteTokens ?? 0
          // Peak/idle bucketing by the request's own time (the durable replay
          // replays historical events, so a resumed session prices each
          // request at the rate window it actually ran in — the session cost
          // estimate never prices the whole session at the current window).
          {
            const bucket = isPeakHour(new Date(event.time))
              ? state.tokens.peak
              : state.tokens.idle
            bucket.input += usage.inputTokens ?? 0
            bucket.output += usage.outputTokens ?? 0
            bucket.cacheRead += usage.cacheReadTokens ?? 0
            bucket.cacheWrite += usage.cacheWriteTokens ?? 0
          }
          // The most recent request's usage describes the CURRENT context:
          // input (uncached) + cache hits all occupy the window. Cache hits
          // also drive the status-line `cache N` readout.
          state.lastUsage = {
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack tokens
            input: usage.inputTokens ?? 0,
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack tokens
            output: usage.outputTokens ?? 0,
            cacheRead: usage.cacheReadTokens ?? 0,
            cacheWrite: usage.cacheWriteTokens ?? 0,
          }
        }
        const tpsMessageStep = tpsStep
        if (
          tpsTurn === event.data.turn &&
          tpsMessageStep !== undefined &&
          tpsMessageStep.turn === event.data.turn &&
          tpsMessageStep.step === event.data.step &&
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
          tpsMessageStep.turn === event.data.turn &&
          tpsMessageStep.step === event.data.step
        ) {
          tpsStep = undefined
        }
        // Context-bar segmentation (pi-nano-context style): assistant text
        // and tool calls in the assistant segment, thinking separately.
        for (const block of event.data.message.content) {
          if (block.type === 'text' && block.text) {
            state.contextSegments.assistant += estimateTokens(block.text)
          } else if (block.type === 'reasoning' && block.text) {
            state.contextSegments.thinking += estimateTokens(block.text)
          }
        }
        break
      }
      case 'tool/call': {
        // The ask-user-question tool renders as the interactive questionnaire
        // panel (DSH user-interaction seam), not as a tool card: the model is
        // parked waiting for the human, so no running card, no active-tool
        // spinner, no args noise in the transcript. The Q&A summary is pushed
        // by the TUI once the batch is answered; tool/result for a call with
        // no card is a no-op below.
        if (event.data.name === 'ask_user_question') break
        // The Task tool's plain card is replaced by the live subagent card
        // (Kimi Code semantics): the delegation itself renders as a subagent
        // row, so the raw args/result card would only duplicate it. The call
        // still runs - only its transcript rendering is suppressed.
        if (isSubagentToolName(event.data.name)) {
          try {
            const args = JSON.parse(event.data.arguments) as { description?: unknown }
            if (typeof args.description === 'string' && args.description) deps.pendingTaskDescriptions.push(args.description)
          } catch {
            // Unparseable args leave the queue untouched; the card falls back
            // to the provider label.
          }
          break
        }
        // Reasoning that led to a tool call is done thinking — fold the
        // preview now, before the tool card grows the transcript past it
        // (see foldLiveReasoning).
        foldLiveReasoning('tool call')
        const card: ChatRow = {
          id: deps.rowIds.value,
          kind: 'tool',
          text: '',
          seq: event.seq,
          // Smooth-reveal participation flag: live cards animate their body
          // in; replayed cards (resume/rewind) paint complete.
          fresh: !replaying,
          tool: {
            callId: event.data.callId,
            name: event.data.name,
            argsText: preview(event.data.arguments, ARGS_PREVIEW_LIMIT),
            argsFull: event.data.arguments,
            status: 'running',
            callView: presentCallView(event.data.name, event.data.arguments),
            startedAt: Date.now(),
          },
        }
        deps.rowIds.value += 1
        toolCards.set(event.data.callId, card)
        appendRow(card)
        state.activeToolCount += 1
        state.contextSegments.assistant += estimateTokens(
          `${event.data.name}${event.data.arguments}`,
        )
        updateSpinnerMode()
        break
      }
      case 'tool/result': {
        const card = toolCards.get(event.data.message.source.callId)
        if (card !== undefined && card.tool !== undefined) {
          const images = transcriptImages(event.data.message.content)
          card.images = images.length === 0 ? undefined : images
          card.tool.durationMs = Math.max(0, Date.now() - card.tool.startedAt)
          const failure = event.data.error
          if (failure !== undefined) {
            card.tool.status = 'error'
            const errorText = toolErrorText(event)
            card.tool.errorText = errorText
            state.contextSegments.tools += estimateTokens(errorText)
          } else {
            card.tool.status = 'ok'
            const block = event.data.message.content[0]
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable session data may not match type
            const result = block !== undefined && block.type === 'tool-result' ? textOf(block.content) : ''
            card.tool.resultFull = result || undefined
            card.tool.resultText = result ? preview(result, RESULT_PREVIEW_LIMIT) : undefined
            // The tool's own settled-state view (applied diff, terminal
            // output, read content…) wins over the raw text body. argsFull
            // pairs the args: live cards are never folded, so it is intact.
            card.tool.resultView = presentResultView(card.tool.name, card.tool.argsFull ?? '', event.data)
            state.contextSegments.tools += estimateTokens(result)
            // A job_output result doubles as the job card's output feed:
            // the registry's read() is consuming and reserved for the
            // owning agent, so the UI mirrors the tail that already streams
            // through the transcript instead of polling the job itself.
            if (card.tool.name === 'job_output' && result !== '') {
              const id = parseJobOutputId(card.tool.argsFull)
              if (id !== undefined) deps.jobs.onOutputSeen(id, result, event.time ?? Date.now())
            }
            // A `started background job <id>` ack pairs the job with its
            // tool call: capture the FULL command from the args (the
            // registry label is the friendly description) for the panel.
            const startAck = BACKGROUND_START_ACK.exec(result)
            if (startAck !== null) {
              const command = toolCommandOf(card.tool.argsFull)
              if (command !== undefined) deps.jobs.onStarted(startAck[1], command)
            }
          }
          state.activeToolCount = Math.max(0, state.activeToolCount - 1)
          // The card is settled: no later event looks it up by callId, so
          // drop the index entry. The card itself stays in state.rows
          // (bounded by MAX_ROWS + foldRows, which also drops the full
          // args/result payloads of folded cards).
          toolCards.delete(event.data.message.source.callId)
          touchRow(card)
          updateSpinnerMode()
        }
        break
      }
      case 'step/end': {
        if (
          tpsStep !== undefined &&
          tpsStep.turn === event.data.turn &&
          tpsStep.step === event.data.step
        ) {
          tpsStep = undefined
        }
        break
      }
      case 'turn/start': {
        deps.inputConvergence.cancelInFlight = false
        state.cancelPending = false
        state.working = true
        state.turnStart = Date.now()
        state.responseChars = 0
        state.spinnerMode = 'requesting'
        // Keep the prior turn visible until this turn produces a measurable
        // decode span, while starting a fresh weighted step fold.
        tpsBeforeTurn = state.tps
        tpsTurn = event.data.turn
        tpsTurnDecodeMs = 0
        tpsTurnDecodeTokens = 0
        tpsTurnSampled = false
        tpsStep = undefined
        break
      }
      case 'turn/end': {
        deps.inputConvergence.cancelInFlight = false
        state.cancelPending = false
        settleStreaming()
        state.working = false
        state.activeToolCount = 0
        if (tpsTurn !== undefined && tpsTurn === event.data.turn) {
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
        const reason = event.data.reason
        if (reason.kind === 'completed') {
          deps.checkContextWarning()
          break
        }
        if (reason.kind === 'aborted' || reason.kind === 'interrupted') {
          // `Agent.cancel()` closes the turn as `aborted`; `interrupted`
          // only appears for crash-orphaned turns. Claude Code renders both
          // user-interruption paths as a distinct dim row.
          appendRow({
            id: deps.rowIds.value,
            kind: 'interrupt',
            text: t('interrupted-by-user') + t('interrupted-ask-next'),
          })
          deps.rowIds.value += 1
          break
        }
        // The notice renders as a single-line Divider title: error.message
        // can carry newlines/control chars, and an embedded \n splits the
        // rule across rows. cleanRenderText is the render-path single-line
        // contract (sessionTree's preview() folds likewise for the tree).
        const detail = reason.kind === 'error' ? cleanRenderText(reason.error.message, NOTICE_CELLS) : ''
        appendRow({ id: deps.rowIds.value, kind: 'notice', text: `turn ${reason.kind}${detail ? ` · ${detail}` : ''}` })
        deps.rowIds.value += 1
        deps.notify(
          t('turn-failed', { detail: detail ? ` · ${detail}` : '' }),
          { color: 'error', timeoutMs: 8000 },
        )
        break
      }
      case 'request/context':
        // Adapter-advertised context capacity; drives the context-low
        // warning (CC's TokenWarning) when the route reports one.
        if (event.data.contextWindow !== undefined) {
          state.contextWindow = event.data.contextWindow
        }
        break
      case 'request/header': {
        // Reasoning effort readout (status line): the header carries the
        // conversation's call config (provider/model/effort/sampling). The
        // system prompt text seeds the context bar's system segment.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable session data may lack header config
        const effort = event.data.header.config?.reasoningEffort
        if (typeof effort === 'string') {
          state.reasoningEffort = effort
        }
        if (typeof event.data.header.system === 'string') {
          state.contextSegments.system = estimateTokens(event.data.header.system)
        }
        break
      }
      case 'session/title':
        state.sessionTitle = event.data.title
        break
      default:
        // dsh-tool-todo owns this optional module augmentation in alpha.2.
        // Match by name so the TUI remains loadable without that plugin.
        if ((event as { type: string }).type === 'todo/write') {
          const todos = todoPanelItems((event as unknown as { data?: unknown }).data)
          if (todos !== undefined) state.todos = todos
          break
        }
        // Logged preset switch (blank sessions only, issue #8): a transcript
        // marker so a replayed log shows which composition produced the
        // turns after it. Not in dsh-session's typed union — matched here by
        // name, like the other plugin-defined events above.
        if ((event as { type: string }).type === 'agent-preset/selected') {
          const data = event.data as unknown as { agentPreset?: string }
          const recordedPreset = typeof data.agentPreset === 'string' ? data.agentPreset : undefined
          const renamedOfficialPreset =
            (recordedPreset === 'code' && state.agentPreset === 'ptc') ||
            (recordedPreset === 'ptc' && state.agentPreset === 'code')
          const preset = renamedOfficialPreset && state.agentPreset !== undefined
            ? state.agentPreset
            : recordedPreset ?? 'unknown'
          appendRow({
            id: deps.rowIds.value,
            kind: 'notice',
            text: t('agent-preset-switched', { preset }),
          })
          deps.rowIds.value += 1
          break
        }
        // `/color` accent (dsh-tui plugin event, replayed on resume/rewind
        // like session/title): last write wins, '' clears to the default.
        if ((event as { type: string }).type === 'session/color') {
          const data = event.data as unknown as { color?: unknown }
          state.sessionColor = typeof data.color === 'string' ? data.color : ''
          break
        }
        // Custom plugin events (tuiRenderers seam): a registered renderer
        // maps the payload to text rows — title as a local row, body as
        // preview-clipped local-output rows, same shape pushLocal uses.
        // Runs on the live stream AND on replay (resume/rewind), so the
        // projection must stay total; the runtime isolates renderer
        // crashes per type.
        if (deps.renderer !== undefined) {
          const rendered = deps.renderer.render(
            (event as { type: string }).type,
            (event as { data?: unknown }).data,
          )
          if (rendered !== undefined) {
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
          }
        }
        break
    }
  }


  function reset(): void {
    streaming = undefined
    reasoning = undefined
    sealedReasoning.length = 0
    lastReasoningRow = undefined
    toolCards.clear()
    handledAssistantMessages.clear()
    handledAssistantChunks.clear()
    assistantRowsByStep.clear()
    lastTextDelta.clear()
    tpsTurn = undefined
    tpsStep = undefined
    tpsTurnDecodeMs = 0
    tpsTurnDecodeTokens = 0
    tpsTurnSampled = false
  }
  return { reset, replayEvents, renderEvent, settleStreaming, updateSpinnerMode, presentCallView, presentResultView, textOf, firstTextOf }
}
