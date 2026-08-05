import { randomUUID } from 'node:crypto'
import type { Agent, AgentHandle, AgentStatus, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { Context } from 'cordis'
import { join } from 'node:path'
import { type SessionRecord, writeResumeTarget } from './sessionHistory.js'
import type { SpinnerMode } from './components/Spinner/spinnerMode.js'

/** Tool-call card state, mirroring the Claude Code tool-use presentation. */
export interface ToolRow {
  readonly callId: string
  readonly name: string
  /** Raw JSON arguments as the model produced them (displayed truncated). */
  readonly argsText: string
  /** Full arguments, shown when Ctrl+O verbose mode is on. */
  readonly argsFull: string
  status: 'running' | 'ok' | 'error'
  resultText?: string
  /** Full result text, shown when Ctrl+O verbose mode is on. */
  resultFull?: string
  errorText?: string
  /** Wall-clock start of the call (live elapsed while running). */
  startedAt: number
  /** Settled wall-clock duration, written by tool/result. */
  durationMs?: number
}

/**
 * One rendered transcript row. The DSH session log is the source of truth:
 * rows are derived from `session/event` records (and the initial
 * `agent.session.events` replay), never from optimistic local state.
 */
export interface ChatRow {
  id: number
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'reasoning' | 'interrupt' | 'local' | 'local-output'
  /** Extra label for non-human user rows (e.g. `steering`). */
  label?: string
  text: string
  /** True while an assistant step is still streaming chunks. */
  streaming?: boolean
  /** Present on `tool` rows; the card model. */
  tool?: ToolRow
  /** Event wall-clock time (transcript-mode metadata, assistant rows). */
  time?: number
  /** Present on `reasoning` rows once settled: thinking wall-clock duration. */
  durationMs?: number
  /** Source session event seq (user rows) — the rewind fork anchor. */
  seq?: number
}

export interface TokenUsage {
  input: number
  output: number
}

/**
 * Latest `activity/status` snapshot (the log-only event appended by
 * `@deepseek-ai/dsh-working-activity` for any UI consumer): the model's
 * live working line — thinking copy, running tool, turn summary. cc-tui
 * renders it on the status line; nothing here requires the plugin (absent
 * events simply leave the slot empty).
 */
export interface ActivityStatus {
  readonly phase: 'idle' | 'waiting' | 'thinking' | 'tool' | 'done'
  /** Human-readable status line (plain text, no ANSI). */
  readonly line: string
  readonly label?: string
  readonly detail?: string
  readonly phrase?: string
  readonly toolCount: number
  readonly turnElapsedMs: number
}

/** A transient status message shown above the prompt input. */
export interface NotificationItem {
  id: number
  text: string
  /** Theme color key; defaults to dim. */
  color?: 'error' | 'warning' | 'success'
  /** Auto-dismiss after this many ms (default 4000). */
  timeoutMs: number
}

export interface Channel {
  /** Monotonic version — bump on every mutation so screens can re-render. */
  readonly version: number
  readonly rows: readonly ChatRow[]
  readonly status: AgentStatus | 'starting' | 'disposed'
  readonly sessionTitle: string
  readonly agentId: string
  /** Resolved model id (from the plugin config). */
  readonly model: string
  /** Running token totals across the session's assistant messages. */
  readonly tokens: TokenUsage
  /** Working directory of the session. */
  readonly cwd: string
  /** Current git branch, when the cwd is inside a git worktree. */
  readonly gitBranch: string | undefined
  /** True between turn/start and turn/end — drives the working spinner. */
  readonly working: boolean
  /** Which phase the spinner should present while working. */
  readonly spinnerMode: SpinnerMode
  /** Chars streamed as text this turn (feeds the spinner token counter). */
  readonly responseChars: number
  /** Number of tool calls still in flight this turn. */
  readonly activeToolCount: number
  /** Wall-clock ms of turn/start (spinner elapsed timer). */
  readonly turnStart: number
  /** Last user prompt text (sticky header + statusline). */
  readonly lastUserText: string
  /** Transient notifications, newest last. */
  readonly notifications: readonly NotificationItem[]
  /** Adapter-advertised context capacity for the model route, when known. */
  readonly contextWindow: number | undefined
  /** Reasoning effort of the latest request header, when the adapter sets one. */
  readonly reasoningEffort: string | undefined
  /** Usage of the most recent request (context share + cache hits come from
   *  this, not the running totals — each request's input IS the context). */
  readonly lastUsage:
    | { input: number; output: number; cacheRead: number; cacheWrite: number }
    | undefined
  /** Output tokens per second of the current/last turn's response, when known. */
  readonly tps: number | undefined
  /** Per-message tps samples (sparkline + μ/p95 readout), oldest first. */
  readonly tpsSamples: readonly { tps: number; at: number }[]
  /** Latest working-activity snapshot (log-only `activity/status` event),
   *  when the leaf mounts dsh-working-activity. */
  readonly workingActivity: ActivityStatus | undefined
  /** Working-activity indicator preset name (`claude`/`moon`/…/`random`). */
  readonly activityFrames: string | undefined
  /** Whether working-activity events are consumed (config.activity). */
  readonly activityEnabled: boolean
  /** Estimated context segments by content type (pi-nano-context style bar). */
  readonly contextSegments: {
    system: number
    prompt: number
    assistant: number
    thinking: number
    tools: number
  }
  subscribe(listener: () => void): () => void
  submit(text: string): void
  /** Abort the in-flight turn (`Ctrl+C` while working). */
  cancel(): void
  /** Rewind the conversation to a past user message (CC's double-Esc rewind):
   *  forks the session through that message, swaps in a fresh agent, and
   *  returns the message text for re-editing — or `null` when unwritable. */
  rewindTo(row: ChatRow): Promise<string | null>
  /** Reset the visible transcript (`/clear`). */
  clear(): void
  /** Push a transient notification above the prompt input. */
  notify(text: string, options?: { color?: NotificationItem['color']; timeoutMs?: number }): void
  /** Advertised models for the configured provider route (empty when the LLM service is absent). */
  listModels(): Promise<readonly LlmModelInfo[]>
  /** Top-level entries of the session cwd for `@` file completion. */
  listFiles(): Promise<readonly string[]>
  /** Recent sessions recorded by the DSH persistence backend (for `/resume`). */
  listSessions(): Promise<readonly SessionRecord[]>
  /** Mark a session for `dsh-cc --resume` on the next launch. */
  setResumeTarget(sessionId: string): void
  /** Manually compact the session history (CC's /compact); no-op notify when the leaf lacks a compaction service. */
  compact(): void
}

/** @internal */
export interface ChannelState {
  version: number
  rows: ChatRow[]
  status: AgentStatus | 'starting' | 'disposed'
  sessionTitle: string
  agentId: string
  model: string
  tokens: TokenUsage
  cwd: string
  gitBranch: string | undefined
  working: boolean
  spinnerMode: SpinnerMode
  responseChars: number
  activeToolCount: number
  turnStart: number
  lastUserText: string
  notifications: NotificationItem[]
  /** Adapter-advertised context capacity for the model route, when known. */
  contextWindow: number | undefined
  /** Reasoning effort of the latest request header, when the adapter sets one. */
  reasoningEffort: string | undefined
  /** Usage of the most recent request (context share + cache hits). */
  lastUsage:
    | { input: number; output: number; cacheRead: number; cacheWrite: number }
    | undefined
  /** Output tokens per second of the current/last turn's response, when known. */
  tps: number | undefined
  /** Per-message tps samples (sparkline + μ/p95 readout), oldest first. */
  tpsSamples: { tps: number; at: number }[]
  /** Latest working-activity snapshot (see the public Channel type). */
  workingActivity: ActivityStatus | undefined
  /** Working-activity indicator preset (see the public Channel type). */
  activityFrames: string | undefined
  /** Working-activity consumption switch (see the public Channel type). */
  activityEnabled: boolean
  /** Estimated context segments by content type (pi-nano-context style bar). */
  contextSegments: {
    system: number
    prompt: number
    assistant: number
    thinking: number
    tools: number
  }
  subscribe(listener: () => void): () => void
  /** @internal event bump (the public `notify(text)` posts a notification). */
  emit(): void
  submit(text: string): void
  cancel(): void
  rewindTo(row: ChatRow): Promise<string | null>
  clear(): void
  notify(text: string, options?: { color?: NotificationItem['color']; timeoutMs?: number }): void
  listModels(): Promise<readonly LlmModelInfo[]>
  listFiles(): Promise<readonly string[]>
  listSessions(): Promise<readonly SessionRecord[]>
  setResumeTarget(sessionId: string): void
  /** Manually compact the session history (CC's /compact). */
  compact(): void
}

const ARGS_PREVIEW_LIMIT = 160
const RESULT_PREVIEW_LIMIT = 240

/** Local `!`-command output cap (mirrors the result preview limit). */
const LOCAL_OUTPUT_LIMIT = 240

function preview(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}


/** True while a reasoning row is streaming (spinner mode = thinking). */
function hasStreamingReasoning(rows: readonly ChatRow[]): boolean {
  return rows.some(row => row.kind === 'reasoning' && row.streaming)
}

/** Buffer below the context window at which CC warns (autoCompact.ts). */
const CONTEXT_WARNING_BUFFER_TOKENS = 20_000

/** Resolve once a `turn/end` event newer than `fromSeq` lands in the session
 *  log (Agent.cancel closes the turn asynchronously), or when the timeout
 *  expires. Polling the session log is race-free here: fork reads the same
 *  append-only log. */
async function waitForTurnEnd(
  session: { seq: number; events: readonly SessionEvent[] },
  fromSeq: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const last = session.events.at(-1)
    if (last !== undefined && last.type === 'turn/end' && last.seq >= fromSeq) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return false
}

/** @internal */
export function createChannel(
  ctx: Context,
  initialAgent: Agent,
  options: {
    model: string
    cwd: string
    provider: string
    /** Configured reasoning effort, shown from startup until the first
     *  request/header event reports the adapter's live value. */
    effort?: string
    /** Consume `activity/status` session events (dsh-working-activity) into
     *  the status line; default on. */
    activity?: boolean
    /** Indicator preset for the working-activity line (`claude`/`moon`/
     *  `comet`/`dots`/… or `random`); default `claude`. */
    activityFrames?: string
    /** Handle of the initial agent; disposed when a rewind replaces it. */
    handle?: AgentHandle
  },
): ChannelState {
  let agent = initialAgent
  let currentHandle: AgentHandle | undefined = options.handle
  const listeners = new Set<() => void>()
  let nextNotificationId = 1
  /** One-shot context-low warning per session (CC's TokenWarning). */
  let contextWarned = false
  const checkContextWarning = (): void => {
    if (contextWarned || state.contextWindow === undefined) return
    const remaining = state.contextWindow - state.tokens.input
    if (remaining >= CONTEXT_WARNING_BUFFER_TOKENS) return
    contextWarned = true
    const percentLeft = Math.max(
      0,
      Math.round((remaining / state.contextWindow) * 100),
    )
    state.notify(
      `Context low (${percentLeft}% remaining) · Run /clear or start a new session`,
      { color: 'warning', timeoutMs: 8000 },
    )
  }
  const state: ChannelState = {
    version: 0,
    rows: [],
    status: 'starting',
    sessionTitle: '',
    agentId: agent.id,
    model: options.model,
    tokens: { input: 0, output: 0 },
    cwd: options.cwd,
    gitBranch: undefined,
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    notifications: [],
    contextWindow: undefined,
    reasoningEffort: options.effort,
    workingActivity: undefined,
    activityFrames: options.activityFrames,
    activityEnabled: options.activity !== false,
    lastUsage: undefined,
    tps: undefined,
    tpsSamples: [],
    contextSegments: {
      system: 0,
      prompt: 0,
      assistant: 0,
      thinking: 0,
      tools: 0,
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit() {
      state.version += 1
      for (const listener of listeners) listener()
    },
    submit(text) {
      const trimmed = text.trim()
      if (!trimmed) return
      // Claude Code's `!` mode: `!cmd` runs locally and only shows the
      // output; `!!cmd` additionally sends the output to the model as a
      // user message (CC's <bash-stdout> convention).
      if (trimmed.startsWith('!!')) {
        void runLocalCommand(trimmed.slice(2).trim(), true)
        return
      }
      if (trimmed.startsWith('!')) {
        void runLocalCommand(trimmed.slice(1).trim(), false)
        return
      }
      agent.followup(createUserMessage({ content: [{ type: 'text', text: trimmed }], source: { kind: 'user' } }))
    },
    cancel() {
      agent.cancel({ kind: 'user' })
    },
    async rewindTo(row: ChatRow): Promise<string | null> {
      if (row.seq === undefined) return null
      const sessions = ctx.get('sessions') as
        | { fork(source: unknown, boundary?: number): { events: readonly SessionEvent[] } }
        | undefined
      const agents = ctx.get('agents') as
        | { create(options: CreateAgentOptions): Promise<AgentHandle> }
        | undefined
      if (!sessions || !agents) {
        state.notify('Rewind unavailable — session services not loaded', { color: 'error' })
        return null
      }
      // Stop a running turn first and WAIT for its turn/end to land — fork
      // rejects boundaries inside open turns, and Agent.cancel() closes the
      // turn asynchronously (a long thinking turn can take seconds to settle).
      const wasWorking = state.working
      const cancelSeq = agent.session.seq
      if (wasWorking) agent.cancel({ kind: 'user' })
      if (wasWorking) {
        const turnSettled = await waitForTurnEnd(agent.session, cancelSeq, 30000)
        if (!turnSettled) {
          state.notify('Cannot rewind — the turn is still settling, try again in a moment', { color: 'error' })
          return null
        }
      }
      const childId = SessionId(randomUUID())
      // DSH event order is `turn/start → user/message → … → turn/end`, so a
      // message's own seq always sits inside its turn — forking there would
      // hit OPEN_TURN. Rewind to just BEFORE the message's turn/start: the
      // conversation restarts at that point and the message itself comes
      // back into the input for re-editing (CC's rewind semantics).
      const events = agent.session.events
      let boundary = row.seq
      for (let i = row.seq; i >= 0; i--) {
        const event = events[i]
        if (event === undefined) break
        if (event.type === 'turn/start') {
          boundary = event.seq - 1
          break
        }
        if (event.type === 'turn/end') break
      }
      // Slice the seed ourselves instead of storing a fork: agents.create
      // must own the session (a pre-created fork session would collide on
      // the same id). The create boundary validates the seed (contiguous
      // from seq 0, no open turns), which our boundary already guarantees.
      let seed: readonly SessionEvent[]
      try {
        if (boundary < 0) {
          throw new Error('cannot rewind to the very first message')
        }
        seed = sessions.fork(agent.session, boundary).events
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state.notify(`Cannot rewind to this point · ${message}`, { color: 'error' })
        return null
      }
      let handle: AgentHandle
      try {
        handle = await agents.create({
          sessionId: childId,
          seed,
          meta: {
            cwd: options.cwd,
            parentSession: agent.session.id,
            seedLength: seed.length,
          },
          agentOptions: { provider: options.provider, model: options.model },
        })
      } catch {
        state.notify('Rewind failed — could not create the replacement session', { color: 'error' })
        return null
      }
      // Replay the forked history into a fresh transcript (tokens/spinner
      // counters land back at the rewind point, matching the fork).
      streaming = undefined
      reasoning = undefined
      toolCards.clear()
      nextRowId = 0
      state.rows.length = 0
      state.tokens = { input: 0, output: 0 }
      state.responseChars = 0
      state.activeToolCount = 0
      state.lastUserText = ''
      state.working = false
      state.spinnerMode = 'requesting'
      state.status = handle.agent.status
      state.agentId = handle.agent.id
      state.tps = undefined
      state.tpsSamples = []
      state.lastUsage = undefined
      state.workingActivity = undefined
      state.contextSegments = {
        system: 0,
        prompt: 0,
        assistant: 0,
        thinking: 0,
        tools: 0,
      }
      for (const event of seed) renderEvent(event)
      // Rebind subscriptions to the new agent, then free the old one.
      const oldHandle = currentHandle
      agent = handle.agent
      currentHandle = handle
      bindAgent()
      state.emit()
      void oldHandle?.dispose().catch(() => {})
      return row.text
    },
    clear() {
      state.rows.length = 0
      nextRowId = 0
      streaming = undefined
      reasoning = undefined
      toolCards.clear()
      state.activeToolCount = 0
      state.responseChars = 0
      state.rows.push({
        id: nextRowId,
        kind: 'notice',
        text: 'Session cleared',
      })
      nextRowId += 1
      state.emit()
    },
    notify(text, options = {}) {
      const item: NotificationItem = {
        id: nextNotificationId++,
        text,
        color: options.color,
        timeoutMs: options.timeoutMs ?? 4000,
      }
      state.notifications.push(item)
      state.emit()
      setTimeout(() => {
        const index = state.notifications.indexOf(item)
        if (index >= 0) {
          state.notifications.splice(index, 1)
          state.emit()
        }
      }, item.timeoutMs)
    },
    listModels() {
      const llm = ctx.get('llm') as
        | { listModels(provider: string): Promise<readonly LlmModelInfo[]> }
        | undefined
      if (!llm) return Promise.resolve([])
      return llm.listModels(options.provider).catch(() => [])
    },
    listFiles() {
      const fs = ctx.get('fs') as
        | {
            resolve(path: string): Promise<{ displayPath: string }>
            listDir(target: { displayPath: string }): Promise<
              Array<{
                name: string
                type: 'file' | 'directory' | 'other'
                target: { displayPath: string }
              }>
            >
          }
        | undefined
      return listFilesDeep(fs, state.cwd)
    },
    async listSessions() {
      // DSH's own session index: the persistence backend materializes one
      // entry per durable session log (headers carry cwd + createdAt).
      const persistence = ctx.get('sessionPersistence') as
        | { list(signal?: AbortSignal): Promise<readonly SessionHeader[]> }
        | undefined
      if (!persistence) return []
      try {
        const headers = await persistence.list()
        return headers
          .map(header => ({
            id: header.id,
            title: basename(header.cwd ?? '') || header.id,
            cwd: header.cwd ?? '',
            createdAt: header.createdAt,
            updatedAt: header.createdAt,
          }))
          .sort((a, b) => b.updatedAt - a.updatedAt)
      } catch {
        return []
      }
    },
    setResumeTarget(sessionId) {
      writeResumeTarget(sessionId)
    },
    compact() {
      const compactService = ctx.get('compact') as
        | {
            compactNow(
              agent: unknown,
              signal: AbortSignal,
            ): Promise<{ summary?: string } | null>
          }
        | undefined
      if (!compactService) {
        state.notify('Compaction unavailable · no compaction service in this leaf', {
          color: 'warning',
        })
        return
      }
      if (state.working) {
        state.notify('Cannot compact while a turn is running', { color: 'warning' })
        return
      }
      const signal = new AbortController().signal
      state.notify('Compacting conversation…')
      void compactService
        .compactNow(agent, signal)
        .then(result => {
          state.notify(result ? 'Conversation compacted' : 'Nothing to compact')
        })
        .catch(error => {
          state.notify(
            `Compaction failed · ${error instanceof Error ? error.message : String(error)}`,
            { color: 'error', timeoutMs: 8000 },
          )
        })
    },
  }

  let nextRowId = 0
/** The leaf's bash executor (dsh-bash-local in the example leaf) — the DSH
 *  execution seam for local `!` commands and the git status breadcrumb. */
  const bash = ctx.get('bash') as
    | {
        resolve(request: {
          command: string
          workdir?: string
          timeoutMs?: number
        }): { command: string; timeoutMs: number }
        run(spec: { command: string; timeoutMs: number }): Promise<{
          exitCode: number | null
          stdout: { text: string }
          stderr: { text: string }
          timedOut: boolean
        }>
      }
    | undefined

/** Claude Code's `!` mode: run a command on the user's machine and render its
 *  output in the transcript as local rows (never sent to the model). */
  const runLocalCommand = async (
    command: string,
    includeInContext: boolean,
  ): Promise<void> => {
    state.rows.push({ id: nextRowId++, kind: 'local', text: command })
    state.emit()
    let output = '(no output)'
    if (bash) {
      const spec = bash.resolve({
        command,
        workdir: state.cwd,
        timeoutMs: 30000,
      })
      const result = await bash.run(spec)
      output =
        result.stdout.text.trim() ||
        result.stderr.text.trim() ||
        (result.timedOut ? '(timed out)' : '(no output)')
    }
    state.rows.push({
      id: nextRowId++,
      kind: 'local-output',
      text: preview(output, LOCAL_OUTPUT_LIMIT),
    })
    state.emit()
    if (includeInContext) {
      // CC's <bash-stdout> envelope: the model treats the output as the
      // result of a local command the user just ran.
      agent.followup(createUserMessage({
        content: [{
          type: 'text',
          text: `<bash-stdout>
${output}
</bash-stdout>`,
        }],
        source: { kind: 'user' },
      }))
    }
  }
  /** The in-progress assistant text row; `undefined` when no step is streaming. */
  let streaming: ChatRow | undefined
  /** The in-progress reasoning row; `undefined` when no reasoning is streaming. */
  let reasoning: ChatRow | undefined
  /** Wall-clock start of the current reasoning row (durationMs on settle). */
  let reasoningStart = 0
  /** First-output wall-clock + estimated output tokens of the current turn
   *  (live tps readout; refined by exact usage at assistant/message). */
  let turnOutputStart = 0
  let turnOutputTokens = 0
  /** Tool cards by callId, so tool/result can settle the running card. */
  const toolCards = new Map<string, ChatRow>()

  // ContentBlockMap is merge-extensible: plugin-added block types are
  // silently skipped (v1 renders text blocks only) — never crashes.
  const textOf = (content: readonly ContentBlock[] | undefined): string =>
    (content ?? []).map(block => (block.type === 'text' ? block.text : '')).join('').trim()

  const ensureStreaming = (): ChatRow => {
    if (streaming === undefined) {
      streaming = { id: nextRowId, kind: 'assistant', text: '', streaming: true }
      nextRowId += 1
      state.rows.push(streaming)
    }
    return streaming
  }

  const ensureReasoning = (): ChatRow => {
    if (reasoning === undefined) {
      reasoningStart = Date.now()
      reasoning = { id: nextRowId, kind: 'reasoning', text: '', streaming: true }
      nextRowId += 1
      state.rows.push(reasoning)
    }
    return reasoning
  }

  const settleStreaming = (): void => {
    if (streaming !== undefined) streaming.streaming = false
    streaming = undefined
    if (reasoning !== undefined) {
      reasoning.streaming = false
      reasoning.durationMs = Math.max(0, Date.now() - reasoningStart)
    }
    reasoning = undefined
  }

  /** Recompute the spinner phase from live row/tool state. */
  const updateSpinnerMode = (): void => {
    if (state.activeToolCount > 0) {
      state.spinnerMode = 'tool-use'
    } else if (hasStreamingReasoning(state.rows)) {
      state.spinnerMode = 'thinking'
    } else if (streaming !== undefined) {
      state.spinnerMode = 'responding'
    } else {
      state.spinnerMode = 'requesting'
    }
  }

  const renderEvent = (event: SessionEvent): void => {
    switch (event.type) {
      case 'user/message': {
        // Compaction checkpoint: `source = { kind: 'plugin', plugin:
        // 'compact' }` (dsh-compact's COMPACT_CHECKPOINT_SOURCE). CC shows
        // the framed summary after /compact; render it as a Divider title +
        // dim block instead of skipping it like other injected context.
        if (
          event.data.source.kind === 'plugin' &&
          event.data.source.plugin === 'compact'
        ) {
          const summary = textOf(event.data.content)
          state.rows.push({ id: nextRowId, kind: 'notice', text: 'Conversation compacted' })
          nextRowId += 1
          if (summary) {
            state.rows.push({ id: nextRowId, kind: 'local-output', text: summary })
            nextRowId += 1
          }
          break
        }
        // Injected context (plugin/skill source) is not a human bubble; v1
        // renders direct human prompts only.
        if (event.data.source.kind !== 'user') break
        const text = textOf(event.data.content)
        if (text) {
          state.rows.push({ id: nextRowId, kind: 'user', text, seq: event.seq })
          state.lastUserText = text
          state.contextSegments.prompt += estimateTokens(text)
          nextRowId += 1
        }
        break
      }
      case 'steering/message': {
        const text = textOf(event.data.message.content)
        if (text) {
          state.rows.push({ id: nextRowId, kind: 'user', label: 'steering', text, seq: event.seq })
          state.lastUserText = text
          state.contextSegments.prompt += estimateTokens(text)
          nextRowId += 1
        }
        break
      }
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') {
          if (chunk.text) {
            ensureStreaming().text += chunk.text
            state.responseChars += chunk.text.length
            // Live output-speed estimate (chars/4 ≈ tokens) from the first
            // output token of the turn.
            if (turnOutputStart === 0) turnOutputStart = Date.now()
            turnOutputTokens += chunk.text.length / 4
            const elapsedSec = (Date.now() - turnOutputStart) / 1000
            if (elapsedSec > 0.5) state.tps = turnOutputTokens / elapsedSec
          }
        } else if (chunk.type === 'reasoning-delta') {
          if (chunk.text) ensureReasoning().text += chunk.text
        }
        updateSpinnerMode()
        break
      }
      case 'assistant/message': {
        const row = ensureStreaming()
        row.time = event.time
        const text = textOf(event.data.message.content)
        if (text) row.text = text
        row.streaming = false
        streaming = undefined
        if (reasoning !== undefined) {
          reasoning.streaming = false
          reasoning.durationMs = Math.max(0, Date.now() - reasoningStart)
        }
        reasoning = undefined
        updateSpinnerMode()
        const usage = event.data.usage
        if (usage !== undefined) {
          state.tokens.input += usage.inputTokens ?? 0
          state.tokens.output += usage.outputTokens ?? 0
          // The most recent request's usage describes the CURRENT context:
          // input (uncached) + cache hits all occupy the window. Cache hits
          // also drive the status-line `cache N` readout.
          state.lastUsage = {
            input: usage.inputTokens ?? 0,
            output: usage.outputTokens ?? 0,
            cacheRead: usage.cacheReadTokens ?? 0,
            cacheWrite: usage.cacheWriteTokens ?? 0,
          }
          // Refine the live estimate with the exact output total, and record
          // the message-level sample for the sparkline / μ / p95 readout.
          if (turnOutputStart !== 0) {
            const elapsedSec = (Date.now() - turnOutputStart) / 1000
            if (elapsedSec > 0.5) {
              const exactTps = (usage.outputTokens ?? 0) / elapsedSec
              state.tps = exactTps
              state.tpsSamples.push({ tps: exactTps, at: Date.now() })
              if (state.tpsSamples.length > 500) state.tpsSamples.shift()
            }
          }
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
        const card: ChatRow = {
          id: nextRowId,
          kind: 'tool',
          text: '',
          tool: {
            callId: event.data.callId,
            name: event.data.name,
            argsText: preview(event.data.arguments, ARGS_PREVIEW_LIMIT),
            argsFull: event.data.arguments,
            status: 'running',
            startedAt: Date.now(),
          },
        }
        nextRowId += 1
        toolCards.set(event.data.callId, card)
        state.rows.push(card)
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
          card.tool.durationMs = Math.max(0, Date.now() - card.tool.startedAt)
          const failure = event.data.error
          if (failure !== undefined) {
            card.tool.status = 'error'
            const errorText = `${failure.name}: ${failure.code}`
            card.tool.errorText = errorText
            state.contextSegments.tools += estimateTokens(errorText)
          } else {
            card.tool.status = 'ok'
            const block = event.data.message.content[0]
            const result = block !== undefined && block.type === 'tool-result' ? textOf(block.content) : ''
            card.tool.resultFull = result || undefined
            card.tool.resultText = result ? preview(result, RESULT_PREVIEW_LIMIT) : undefined
            state.contextSegments.tools += estimateTokens(result)
          }
          state.activeToolCount = Math.max(0, state.activeToolCount - 1)
          updateSpinnerMode()
        }
        break
      }
      case 'turn/start': {
        state.working = true
        state.turnStart = Date.now()
        state.responseChars = 0
        state.spinnerMode = 'requesting'
        // New turn: fresh output-speed window; the previous turn's tps stays
        // visible until this turn produces output (it describes the last
        // completed response).
        turnOutputStart = 0
        turnOutputTokens = 0
        break
      }
      case 'turn/end': {
        settleStreaming()
        state.working = false
        state.activeToolCount = 0
        const reason = event.data.reason
        if (reason.kind === 'completed') {
          checkContextWarning()
          break
        }
        if (reason.kind === 'aborted' || reason.kind === 'interrupted') {
          // `Agent.cancel()` closes the turn as `aborted`; `interrupted`
          // only appears for crash-orphaned turns. Claude Code renders both
          // user-interruption paths as a distinct dim row.
          state.rows.push({
            id: nextRowId,
            kind: 'interrupt',
            text: 'Interrupted · What should Claude do instead?',
          })
          nextRowId += 1
          break
        }
        const detail = 'failure' in reason && reason.failure ? reason.failure.message : ''
        state.rows.push({ id: nextRowId, kind: 'notice', text: `turn ${reason.kind}${detail ? ` · ${detail}` : ''}` })
        nextRowId += 1
        state.notify(
          `Turn ${reason.kind}${detail ? ` · ${detail}` : ''}`,
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
        break
    }
  }

  // Replay the durable transcript first, then follow live events.
  for (const event of agent.session.events) renderEvent(event)
  settleStreaming()
  // Attached to an idle agent: any replayed turn/start belongs to a previous
  // session run, so the spinner must not come up on boot.
  state.working = false
  state.status = agent.status
  state.emit()

  // Live subscription list, rebound to a fresh agent by rewindTo.
  let agentSubscriptions: Array<() => void> = []
  const bindAgent = (): void => {
    for (const dispose of agentSubscriptions) dispose()
    agentSubscriptions = [
      ctx.on('agent/status', (subject, status) => {
        if (subject !== agent) return
        state.status = status
        state.emit()
      }),
      ctx.on('agent/disposed', subject => {
        if (subject !== agent) return
        state.status = 'disposed'
        state.emit()
      }),
      ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return
        // Live working-activity snapshot (log-only event, appended by
        // dsh-working-activity for UI consumers). Consumed here — NOT in
        // renderEvent — so replayed history never resurrects a stale line
        // (the renderEvent switch's default arm ignores it on replay).
        if (
          options.activity !== false &&
          (event as { type: string }).type === 'activity/status'
        ) {
          const data = event.data as unknown as {
            phase: string
            line: string
            toolCount?: number
            turnElapsedMs?: number
            label?: string
            detail?: string
            phrase?: string
          }
          state.workingActivity = {
            phase: data.phase as ActivityStatus['phase'],
            line: data.line,
            toolCount: data.toolCount ?? 0,
            turnElapsedMs: data.turnElapsedMs ?? 0,
            ...(data.label === undefined ? {} : { label: data.label }),
            ...(data.detail === undefined ? {} : { detail: data.detail }),
            ...(data.phrase === undefined ? {} : { phrase: data.phrase }),
          }
          state.emit()
          return
        }
        renderEvent(event)
        state.emit()
      }),
    ]
  }
  bindAgent()
  // Statusline breadcrumb: current git branch of the session cwd (best-effort).
  if (bash) {
    void bash
      .run(
        bash.resolve({
          command: 'git branch --show-current',
          workdir: options.cwd,
          timeoutMs: 3000,
        }),
      )
      .then(result => {
        const branch = result.stdout.text.trim()
        if (branch !== '') {
          state.gitBranch = branch
          state.emit()
        }
      })
  }

  return state
}

/** Path basename for the resume-list title (`C:/a/b` → `b`). */
function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/** Context-bar token estimate (pi-nano-context: ~4 chars per token). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Recursive `@` file listing through the leaf's fs service (dsh-fs-local):
 * walks up to MAX_DEPTH levels below `root`, skipping VCS/dependency dirs,
 * returning relative paths (directories with a trailing `/`, matching the
 * FileSuggestions tag logic) capped at MAX_FILES entries. Best-effort —
 * unreadable subtrees are skipped, not fatal.
 */
async function listFilesDeep(
  fs: {
    resolve(path: string): Promise<{ displayPath: string }>
    listDir(target: { displayPath: string }): Promise<
      Array<{
        name: string
        type: 'file' | 'directory' | 'other'
        target: { displayPath: string }
      }>
    >
  } | undefined,
  root: string,
): Promise<string[]> {
  if (!fs) return []
  const out: string[] = []
  const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', '.DS_Store', 'dist', 'build'])
  const MAX_DEPTH = 3
  const MAX_FILES = 100

  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
    let entries: Array<{
      name: string
      type: 'file' | 'directory' | 'other'
      target: { displayPath: string }
    }> = []
    try {
      const target = await fs.resolve(dir)
      entries = await fs.listDir(target)
    } catch {
      return // unreadable subtree — skip
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return
      if (SKIP.has(entry.name)) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.type === 'directory') {
        out.push(`${rel}/`)
        await walk(entry.target?.displayPath ?? join(dir, entry.name), rel, depth + 1)
      } else if (entry.type === 'file') {
        out.push(rel)
      }
    }
  }

  await walk(root, '', 1)
  return out
}
