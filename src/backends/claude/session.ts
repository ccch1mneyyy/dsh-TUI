/**
 * One Claude Agent session (docs/agent-backend-design.md §4.4, §4.7, §4.13):
 * a single long-lived streaming-input `query()` per session, fed by a
 * push-based inbox, consumed by one loop that translates every SDK message
 * and hands the batch to the channel.
 *
 * - Input placement (Phase 0 correction): `steer` → `priority:'next'` (joins
 *   the running turn after its tool round), `followup` → `priority:'later'`
 *   while a turn runs (a plain push when idle), `now` → `priority:'now'`;
 *   `uuid` = the channel's `clientMessageId`, so lifecycle frames and echoes
 *   name the input the channel tracks.
 * - Cancellation: `interrupt()`; a `user` cancel keeps queued inputs (they run
 *   next), an `interrupt` cancel drops them when the CLI can
 *   (`interrupt_cancel_queued_v1`) because the channel re-delivers them. Until
 *   a `result`/`idle` confirms, a 30 s timer stands by to force-close the turn
 *   (`turn.end{aborted}` + notice): an interrupted turn may never report.
 * - Permissions (Phase 2): the permission callback fails closed — every
 *   prompt is denied with an explanation and a notice row; the interactive
 *   bridge replaces `decidePermission` in Phase 3. Pending callbacks are
 *   always settled: on answer, on the SDK's abort signal, on dispose.
 * - Disposal: deny pending callbacks → close the inbox (stdin EOF, the CLI
 *   exits on its own) → `close()` the query → abort the controller; then wait
 *   (bounded) for the consumer loop. Idempotent.
 * - Process death or a consumer error marks the session `disposed`, closes
 *   any open turn and says so in a notice.
 */
import type { CanUseTool, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, AgentEventMeta } from '../../agent/events.js'
import type { AgentInput, AgentSession, AgentSessionStatus, CancelCause, SubmitPlacement } from '../../agent/session.js'
import { t } from '../../i18n.js'
import { CLAUDE_BACKEND_ID, CLI_CAPABILITY, cliVersionDrift, VALIDATED_CLI_VERSIONS, VALIDATED_SDK_VERSION } from './contract.js'
import { buildQueryOptions, type StartPermissionMode } from './options.js'
import { createStderrSink, type ClaudeExecutable } from './process.js'
import type { ClaudeSdkModule } from './sdk.js'
import { createClaudeTranslator } from './translate.js'

declare module '../../agent/capabilities.js' {
  interface ClaudeNative {
    /** The SDK session id (also `ref.sessionId`). */
    readonly sessionId: string
    /** `system/init.claude_code_version`, once known. */
    readonly cliVersion: string | undefined
    /** `system/init.capabilities` (open set; feature-detect, never sniff). */
    readonly cliCapabilities: readonly string[]
  }
}

/** The deny message every Phase 2 permission prompt answers with. */
export const PHASE2_DENY_MESSAGE = 'dsh-tui: interactive approvals arrive in the next phase'

/** One permission prompt as the session hands it to its decider. */
export interface ClaudePermissionPrompt {
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly toolUseID: string
  readonly signal: AbortSignal
}

/** Timer seam (tests inject a manual clock). */
export interface ClaudeClock {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const REAL_CLOCK: ClaudeClock = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    handle.unref()
    return handle
  },
  clearTimeout: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

export interface ClaudeSessionDeps {
  readonly sdk: Pick<ClaudeSdkModule, 'query'>
  readonly cwd: string
  readonly sessionId: string
  readonly start: StartPermissionMode
  readonly executable: ClaudeExecutable
  readonly env: Record<string, string>
  readonly host: {
    debug(message: string): void
    /** One child stderr line (deduplicated into notices by the host). */
    stderr?(line: string): void
  }
  /** The installed SDK version (diagnostics). */
  readonly sdkVersion?: string
  /** Notices to show once the channel subscribes (start-time findings). */
  readonly startNotices?: readonly string[]
  /** Answer a permission prompt. Phase 2 default: fail closed. */
  readonly decidePermission?: (prompt: ClaudePermissionPrompt) => Promise<PermissionResult>
  readonly clock?: ClaudeClock
  /** How long a cancel may go unconfirmed before the turn is force-closed. */
  readonly forceSettleMs?: number
  /** Bound on `initializationResult()` (a CLI that never answers). */
  readonly initTimeoutMs?: number
  /** Bound on waiting for the consumer loop after `close()`. */
  readonly closeTimeoutMs?: number
}

type Listener = (batch: readonly AgentEvent[], meta: AgentEventMeta) => void
type Rec = Readonly<Record<string, unknown>>
const rec = (value: unknown): Rec | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Rec : undefined
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** A minimal push-based async iterable: the session's stdin. */
function createInbox<T>() {
  const queue: T[] = []
  const waiters: ((result: IteratorResult<T>) => void)[] = []
  let closed = false
  return {
    push(value: T): void {
      if (closed) throw new Error('dsh-tui: Claude session input is closed')
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter({ value, done: false })
      else queue.push(value)
    },
    close(): void {
      if (closed) return
      closed = true
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true })
    },
    get closed(): boolean { return closed },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: (): Promise<IteratorResult<T>> => {
          const value = queue.shift()
          if (value !== undefined) return Promise.resolve({ value, done: false })
          if (closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise(resolve => { waiters.push(resolve) })
        },
        return: (): Promise<IteratorResult<T>> => {
          closed = true
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }
}

/** Renderer urgency of one translated message (design §3.3 `wake`). */
function wakeOf(message: unknown, events: readonly AgentEvent[]): AgentEventMeta['wake'] {
  const value = rec(message)
  if (value?.type === 'stream_event' && rec(value.event)?.type === 'content_block_delta') return 'frame'
  if (value?.type === 'system' && value.subtype === 'thinking_tokens') return 'frame'
  return events.every(event => event.type === 'session.status' || event.type === 'pending.changed') ? 'none' : 'sync'
}

/** `SDKUserMessage.priority` for a channel placement. */
function priorityOf(placement: SubmitPlacement, turnOpen: boolean): SDKUserMessage['priority'] {
  switch (placement) {
    case 'steer':
      return 'next'
    case 'now':
      return 'now'
    case 'followup':
      return turnOpen ? 'later' : undefined
    default:
      return undefined
  }
}

/** Open one session: start the query, wait for its handshake, start the
 *  consumer loop. Throws (after cleaning up) when the CLI cannot start. */
export async function openClaudeSession(deps: ClaudeSessionDeps): Promise<AgentSession> {
  const clock = deps.clock ?? REAL_CLOCK
  const forceSettleMs = deps.forceSettleMs ?? 30_000
  const listeners = new Set<Listener>()
  /** Batches produced before the channel subscribed (handshake, start notices). */
  const backlog: [readonly AgentEvent[], AgentEventMeta][] = []
  let status: AgentSessionStatus = 'starting'
  let disposing = false
  let disposePromise: Promise<void> | undefined
  let cliVersion: string | undefined
  let cliCapabilities: readonly string[] = []
  let forceTimer: unknown
  const pendingPermissions = new Map<string, (result: PermissionResult) => void>()
  const translator = createClaudeTranslator({ cwd: deps.cwd, userRows: 'lifecycle', debug: deps.host.debug })

  const emit = (events: readonly AgentEvent[], wake: AgentEventMeta['wake'] = 'sync'): void => {
    if (events.length === 0) return
    const meta: AgentEventMeta = { replay: false, wake }
    if (listeners.size === 0) { backlog.push([events, meta]); return }
    for (const listener of [...listeners]) {
      try {
        listener(events, meta)
      } catch (error) {
        deps.host.debug(`claude: listener failed (${errorText(error)})`)
      }
    }
  }

  const clearForceTimer = (): void => {
    if (forceTimer === undefined) return
    clock.clearTimeout(forceTimer)
    forceTimer = undefined
  }

  const deny = (message: string, toolUseID: string): PermissionResult =>
    ({ behavior: 'deny', message, toolUseID, decisionClassification: 'user_reject' })

  /** Phase 2: no interactive approvals yet — refuse, and say why in a row. */
  const phase2Decide = (prompt: ClaudePermissionPrompt): Promise<PermissionResult> => {
    emit([{
      type: 'notice',
      level: 'warning',
      text: prompt.toolName === 'AskUserQuestion' ? t('claude-question-unavailable') : t('claude-approval-unavailable', { tool: prompt.toolName }),
      callId: prompt.toolUseID,
    }])
    return Promise.resolve(deny(PHASE2_DENY_MESSAGE, prompt.toolUseID))
  }
  const decide = deps.decidePermission ?? phase2Decide

  const canUseTool: CanUseTool = (toolName, input, options) => new Promise<PermissionResult>(resolve => {
    const key = options.requestId
    if (disposing) { resolve(deny(PHASE2_DENY_MESSAGE, options.toolUseID)); return }
    const settle = (result: PermissionResult): void => {
      if (!pendingPermissions.delete(key)) return
      options.signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    // The CLI withdrew the prompt (interrupt, turn end, exit): it records the
    // refusal itself; a late answer would be ignored anyway.
    const onAbort = (): void => settle(deny(PHASE2_DENY_MESSAGE, options.toolUseID))
    pendingPermissions.set(key, settle)
    options.signal.addEventListener('abort', onAbort, { once: true })
    // A decider that throws is a refusal, never a hang.
    void Promise.resolve()
      .then(() => decide({ toolName, input, toolUseID: options.toolUseID, signal: options.signal }))
      .then(settle, () => settle(deny(PHASE2_DENY_MESSAGE, options.toolUseID)))
  })

  const inbox = createInbox<SDKUserMessage>()
  const abortController = new AbortController()
  const stderrSink = createStderrSink(line => {
    deps.host.debug(`[claude-stderr] ${line}`)
    deps.host.stderr?.(line)
  })
  const query = deps.sdk.query({
    prompt: inbox,
    options: buildQueryOptions({
      cwd: deps.cwd,
      sessionId: deps.sessionId,
      permissionMode: deps.start.mode,
      executable: deps.executable.path,
      env: deps.env,
      canUseTool,
      stderr: stderrSink,
      abortController,
      // Echoes are the user-row fallback for a CLI without lifecycle frames;
      // requesting them is harmless when lifecycle frames win (the
      // translator ignores an echo of an input it already confirmed).
      replayUserMessages: true,
    }),
  })

  /** Shut the query down; safe to call from any state. */
  const teardown = (): void => {
    clearForceTimer()
    for (const settle of [...pendingPermissions.values()]) settle({ behavior: 'deny', message: PHASE2_DENY_MESSAGE })
    inbox.close()
    try { query.close() } catch (error) { deps.host.debug(`claude: close failed (${errorText(error)})`) }
    abortController.abort()
  }

  /** The CLI went away (or the loop failed) without our dispose. */
  const onExit = (error: unknown): void => {
    if (disposing) return
    disposing = true
    status = 'disposed'
    const reason = error === undefined ? t('claude-process-ended') : errorText(error)
    teardown()
    emit([
      ...translator.forceCloseTurn({ kind: 'error', message: reason }),
      { type: 'notice', level: 'error', text: t('claude-process-exited', { reason }) },
      { type: 'session.status', status: 'disposed' },
    ])
  }

  const afterMessage = (message: unknown, events: readonly AgentEvent[]): void => {
    const value = rec(message)
    if (value?.type === 'result' || (value?.type === 'system' && value.subtype === 'session_state_changed' && value.state === 'idle')) {
      clearForceTimer()
    }
    if (value?.type === 'system' && value.subtype === 'init' && Array.isArray(value.capabilities)) {
      cliCapabilities = value.capabilities.filter((item): item is string => typeof item === 'string')
    }
    for (const event of events) {
      if (event.type !== 'session.ready' || event.backendVersion === undefined || cliVersion !== undefined) continue
      cliVersion = event.backendVersion
      // Drift is reported, never a stop (design §4.2).
      if (cliVersionDrift(cliVersion) !== undefined) {
        emit([{ type: 'notice', level: 'warning', text: t('claude-version-drift', { version: cliVersion, validated: VALIDATED_CLI_VERSIONS.join(', ') }) }])
      }
    }
  }

  try {
    const handshake = query.initializationResult()
    let timer: unknown
    const init = await Promise.race([
      handshake,
      new Promise<never>((_, reject) => {
        timer = clock.setTimeout(() => reject(new Error(t('claude-start-timeout'))), deps.initTimeoutMs ?? 60_000)
      }),
    ]).finally(() => clock.clearTimeout(timer))
    const capabilities = rec(init)?.capabilities
    if (Array.isArray(capabilities)) cliCapabilities = capabilities.filter((item): item is string => typeof item === 'string')
    if (cliCapabilities.length > 0 && !cliCapabilities.includes(CLI_CAPABILITY.lifecycle)) translator.setUserRows('replay')
  } catch (error) {
    disposing = true
    teardown()
    throw error
  }
  status = 'idle'
  for (const text of deps.startNotices ?? []) emit([{ type: 'notice', level: 'warning', text }])

  const consumer = (async (): Promise<void> => {
    try {
      for await (const message of query) {
        let events: readonly AgentEvent[]
        try {
          events = translator.translate(message)
        } catch (error) {
          // A translator bug must not take the session down with it.
          deps.host.debug(`claude: translate failed (${errorText(error)})`)
          continue
        }
        afterMessage(message, events)
        for (const event of events) {
          if (event.type === 'session.status' && event.status !== 'disposed' && !disposing) status = event.status
        }
        emit(events, wakeOf(message, events))
      }
      onExit(undefined)
    } catch (error) {
      onExit(error)
    }
  })()

  const session: AgentSession = {
    ref: { backendId: CLAUDE_BACKEND_ID, sessionId: deps.sessionId },
    cwd: deps.cwd,
    get status(): AgentSessionStatus {
      if (status === 'disposed') return 'disposed'
      return translator.turnOpen ? 'running' : status
    },
    capabilities: {
      native: {
        claude: {
          kind: 'claude',
          sessionId: deps.sessionId,
          get cliVersion() { return cliVersion },
          get cliCapabilities() { return cliCapabilities },
        },
      },
      diagnostics: {
        lines: (): readonly string[] => [
          t('claude-doctor-cli', { path: deps.executable.path ?? t('claude-doctor-bundled'), source: deps.executable.source, version: cliVersion ?? t('doctor-unknown') }),
          ...(cliVersionDrift(cliVersion) === undefined ? [] : [t('claude-version-drift', { version: cliVersion ?? '', validated: VALIDATED_CLI_VERSIONS.join(', ') })]),
          t('claude-doctor-sdk', { version: deps.sdkVersion ?? t('doctor-unknown'), validated: VALIDATED_SDK_VERSION }),
          t('claude-doctor-mode', { mode: deps.start.mode, source: deps.start.source }),
        ],
      },
    },
    // A created session has no durable history yet; resume (Phase 4) reads
    // the CLI's session store.
    history: () => Promise.resolve([]),
    subscribe(listener: Listener) {
      listeners.add(listener)
      if (backlog.length > 0) {
        // Delivered after the subscriber's own setup returns (it may be
        // inside a binding transaction).
        queueMicrotask(() => {
          if (!listeners.has(listener)) return
          for (const [events, meta] of backlog.splice(0)) listener(events, meta)
        })
      }
      return () => { listeners.delete(listener) }
    },
    submit(input: AgentInput, placement: SubmitPlacement) {
      if (disposing || inbox.closed) return Promise.reject(new Error(t('claude-session-closed')))
      // Pasted images and `@image` mentions arrive as image blocks; sending
      // the text without them would silently drop part of the message.
      if ((input.images?.length ?? 0) > 0 || (input.blocks ?? []).some(block => block.type === 'image')) {
        return Promise.reject(new Error(t('claude-images-unsupported')))
      }
      const texts = (input.blocks ?? [{ type: 'text', text: input.text }])
        .flatMap(block => block.type === 'text' && typeof block.text === 'string' && block.text !== '' ? [block.text] : [])
      const content = texts.length <= 1 ? texts[0] ?? input.text : texts.map(text => ({ type: 'text' as const, text }))
      const priority = priorityOf(placement, translator.turnOpen)
      translator.registerInput(input.clientMessageId, input.text, placement)
      try {
        inbox.push({
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
          uuid: input.clientMessageId as SDKUserMessage['uuid'],
          ...(priority === undefined ? {} : { priority }),
        })
      } catch (error) {
        translator.unregisterInput(input.clientMessageId)
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
      return Promise.resolve({ accepted: true })
    },
    // No synchronous withdrawal (`retractPending` absent): never called.
    removePending: () => false,
    async cancel(cause: CancelCause) {
      if (disposing) return { stillQueued: [] }
      if (translator.turnOpen && forceTimer === undefined) {
        forceTimer = clock.setTimeout(() => {
          forceTimer = undefined
          if (disposing || !translator.turnOpen) return
          emit([
            ...translator.forceCloseTurn({ kind: 'aborted' }),
            { type: 'notice', level: 'warning', text: t('claude-cancel-forced') },
            { type: 'session.status', status: 'requires-action' },
          ])
        }, forceSettleMs)
      }
      // `interrupt` re-delivers the queue itself, so the queued inputs go with
      // the turn when the CLI can drop them; a user cancel keeps them.
      const cancelQueued = cause !== 'user' && cliCapabilities.includes(CLI_CAPABILITY.interruptCancelQueued)
      // The documented `cancel_queued` interrupt field is reachable through
      // the runtime method's option bag (absent from the TS signature).
      const interrupt = query.interrupt as (options?: { cancelQueued?: boolean }) => Promise<unknown>
      try {
        const receipt = rec(await interrupt.call(query, cancelQueued ? { cancelQueued: true } : undefined))
        const stillQueued = Array.isArray(receipt?.still_queued) ? receipt.still_queued.filter((id): id is string => typeof id === 'string') : []
        return { stillQueued }
      } catch (error) {
        deps.host.debug(`claude: interrupt failed (${errorText(error)})`)
        return { stillQueued: [] }
      }
    },
    dispose(): Promise<void> {
      if (disposePromise !== undefined) return disposePromise
      disposePromise = (async () => {
        const wasDisposed = status === 'disposed'
        disposing = true
        status = 'disposed'
        teardown()
        let timer: unknown
        await Promise.race([
          consumer,
          new Promise<void>(resolve => { timer = clock.setTimeout(resolve, deps.closeTimeoutMs ?? 5000) }),
        ])
        clock.clearTimeout(timer)
        if (!wasDisposed) emit([{ type: 'session.status', status: 'disposed' }], 'none')
        listeners.clear()
        backlog.length = 0
      })()
      return disposePromise
    },
  }
  return session
}
