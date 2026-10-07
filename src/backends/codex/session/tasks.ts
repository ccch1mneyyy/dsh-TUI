/** Background terminals have no exit notifications: poll their native inventory. */
import { Buffer } from 'node:buffer'
import type { SessionCapabilities } from '../../../agent/capabilities.js'
import type { AgentEvent } from '../../../agent/events.js'
import { t } from '../../../i18n.js'
import { arr, errorText, rec, str, type Rec } from '../narrow.js'
import { CLIENT, NOTIFY } from '../protocol/index.js'
import { REAL_CLOCK, rpcCode, RPC_ERROR, type RpcClock } from '../rpc/client.js'
import type { CodexHub } from '../rpc/hub.js'

export const CODEX_TASK_POLL_MS = 2000
export const CODEX_TASK_OUTPUT_BYTES = 64 * 1024
const MAX_TERMINALS = 64 // Codex's native unified-exec inventory bound.
type Terminal = { id: string; itemId: string; command: string; live: boolean; announced: boolean; stopped: boolean; output: string; pending: string }
const tail = (text: string): string => {
  const bytes = Buffer.from(text)
  if (bytes.length <= CODEX_TASK_OUTPUT_BYTES) return text
  let offset = bytes.length - CODEX_TASK_OUTPUT_BYTES
  while ((bytes[offset]! & 0xc0) === 0x80) offset += 1
  return bytes.subarray(offset).toString('utf8')
}

export function createCodexTasks(deps: {
  readonly hub: Pick<CodexHub, 'call'>
  threadId(): string
  emit(events: readonly AgentEvent[]): void
  readonly now?: () => number
  readonly clock?: RpcClock
  debug?(message: string): void
}) {
  const clock = deps.clock ?? REAL_CLOCK
  const now = deps.now ?? Date.now
  const terminals = new Map<string, Terminal>()
  let enabled = true
  let closed = false
  let generation = 0
  let timer: unknown
  let outputTimer: unknown
  let inFlight: Promise<void> | undefined
  const cancelTimer = (): void => { if (timer !== undefined) clock.clearTimeout(timer); timer = undefined }
  const flushOutput = (): void => {
    if (outputTimer !== undefined) clock.clearTimeout(outputTimer)
    outputTimer = undefined
    const events: AgentEvent[] = []
    for (const entry of terminals.values()) if (entry.announced && entry.pending !== '') {
      events.push({ type: 'task.output', taskId: entry.id, text: entry.pending, time: now() })
      entry.pending = ''
    }
    if (!closed && events.length > 0) deps.emit(events)
  }
  const unsupported = (error: unknown): boolean => {
    if (rpcCode(error) !== RPC_ERROR.methodNotFound && rpcCode(error) !== RPC_ERROR.invalidParams) return false
    if (enabled) deps.emit([{ type: 'notice', level: 'warning', key: 'codex-tasks-unsupported', text: t('codex-tasks-unsupported') }])
    enabled = false
    cancelTimer()
    return true
  }
  const remember = (id: string, itemId: string, command: string): Terminal => {
    let entry = terminals.get(id)
    if (entry === undefined) {
      entry = { id, itemId, command, live: false, announced: false, stopped: false, output: '', pending: '' }
      terminals.set(id, entry)
      if (terminals.size > MAX_TERMINALS * 2) {
        const stale = [...terminals.values()].find(item => !item.live && item.id !== id)
        if (stale !== undefined) terminals.delete(stale.id)
      }
    } else { entry.itemId = itemId; entry.command = command }
    return entry
  }
  const schedule = (): void => {
    cancelTimer()
    if (closed || !enabled || ![...terminals.values()].some(entry => entry.live)) return
    timer = clock.setTimeout(() => { timer = undefined; void refresh() }, CODEX_TASK_POLL_MS)
  }
  const refresh = (): Promise<void> => {
    if (closed || !enabled) return Promise.resolve()
    if (inFlight !== undefined) return inFlight
    const root = deps.threadId()
    const epoch = generation
    const request = (async () => {
      try {
        const found = new Map<string, Rec>()
        let cursor: string | undefined
        let pages = 0
        do {
          pages += 1
          const result = rec(await deps.hub.call(CLIENT.backgroundTerminalsList, { threadId: root, limit: MAX_TERMINALS, ...(cursor === undefined ? {} : { cursor }) }))
          for (const raw of arr(result?.data)) {
            const entry = rec(raw)
            const id = str(entry?.processId)
            if (entry !== undefined && id !== undefined) found.set(id, entry)
          }
          cursor = str(result?.nextCursor)
        } while (cursor !== undefined && found.size < MAX_TERMINALS && pages < 4)
        if (closed || epoch !== generation || root !== deps.threadId()) return
        const events: AgentEvent[] = []
        for (const [id, data] of found) {
          const entry = remember(id, str(data.itemId) ?? '', str(data.command) ?? '')
          entry.live = true
          if (!entry.announced) {
            entry.announced = true
            events.push({ type: 'task.start', taskId: id, kind: 'shell', description: entry.command, command: entry.command, ...(entry.itemId === '' ? {} : { callId: entry.itemId }), background: true, time: now() })
            if (entry.output !== '') events.push({ type: 'task.output', taskId: id, text: entry.output, time: now() })
          }
        }
        // Only a complete inventory can prove a process disappeared.
        if (cursor === undefined) for (const entry of terminals.values()) {
          if (!entry.live || found.has(entry.id)) continue
          flushOutput()
          entry.live = false
          events.push({ type: 'task.end', taskId: entry.id, status: entry.stopped ? 'stopped' : 'completed', summary: t(entry.stopped ? 'codex-terminal-stopped' : 'codex-terminal-ended'), time: now() })
        }
        events.push({ type: 'tasks.snapshot', taskIds: [...terminals.values()].filter(entry => entry.live).map(entry => entry.id) })
        if (events.length > 0) deps.emit(events)
      } catch (error) {
        if (!closed && epoch === generation && root === deps.threadId() && !unsupported(error)) deps.debug?.('codex: terminal inventory failed (' + errorText(error) + ')')
      }
    })()
    inFlight = request
    void request.finally(() => { if (inFlight === request) inFlight = undefined; if (epoch === generation) schedule() })
    return request
  }
  const capability: NonNullable<SessionCapabilities['tasks']> = {
    async stop(id) {
      const entry = terminals.get(id)
      if (!enabled || closed || entry?.live !== true) return false
      const root = deps.threadId()
      const epoch = generation
      try {
        const response = rec(await deps.hub.call(CLIENT.backgroundTerminalsTerminate, { threadId: root, processId: id }))
        if (closed || epoch !== generation || root !== deps.threadId() || response?.terminated !== true) return false
        entry.stopped = true
        await refresh()
        return true
      } catch (error) {
        if (closed || epoch !== generation || root !== deps.threadId() || unsupported(error)) return false
        throw error
      }
    },
    get readOutput() {
      if (![...terminals.values()].some(entry => entry.output !== '')) return undefined
      return async (id: string): Promise<string> => {
        const output = terminals.get(id)?.output
        if (output === undefined || output === '') throw new Error(t('codex-terminal-no-output'))
        return output
      }
    },
  }
  return {
    get capability() { return enabled && !closed ? capability : undefined },
    initialize: refresh,
    refresh,
    notification(method: string, params: Rec): boolean {
      if (closed || !enabled || str(params.threadId) !== deps.threadId()) return false
      if (method === NOTIFY.turnStarted || method === NOTIFY.turnCompleted) { void refresh(); return false }
      if (method === NOTIFY.itemStarted || method === NOTIFY.itemCompleted) {
        const item = rec(params.item)
        const id = item?.type === 'commandExecution' ? str(item.processId) : undefined
        if (id !== undefined) {
          const entry = remember(id, str(item?.id) ?? '', str(item?.command) ?? '')
          const output = str(item?.aggregatedOutput)
          if (output !== undefined && output !== '') entry.output = tail(output)
        }
      } else if (method === NOTIFY.commandOutputDelta) {
        const entry = [...terminals.values()].find(value => value.itemId === str(params.itemId))
        const text = str(params.delta)
        if (entry !== undefined && text !== undefined && text !== '') {
          entry.output = tail(entry.output + text)
          if (entry.announced) {
            entry.pending = tail(entry.pending + text)
            outputTimer ??= clock.setTimeout(flushOutput, 100)
          }
        }
      }
      return false
    },
    reset(): void { generation += 1; cancelTimer(); if (outputTimer !== undefined) clock.clearTimeout(outputTimer); outputTimer = undefined; terminals.clear(); inFlight = undefined },
    close(): void { closed = true; generation += 1; cancelTimer(); if (outputTimer !== undefined) clock.clearTimeout(outputTimer); outputTimer = undefined },
  }
}
