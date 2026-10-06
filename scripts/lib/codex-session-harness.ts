/**
 * A Codex session on the fake app-server (scripts/lib/codex-fake-app-server.ts)
 * for the session-level regressions (input, approvals, chat): the real hub,
 * the real session, an in-memory prefs store, a manual clock, and helpers
 * that script the server side of a turn.
 *
 * Import from TypeScript scripts run with `node --import tsx/esm`.
 */
import type { AgentEvent, AgentEventMeta } from '../../src/agent/events.js'
import type { AgentSession } from '../../src/agent/session.js'
import { memoryCodexPrefs, type CodexPrefsData } from '../../src/backends/codex/prefs.js'
import type { RpcClock } from '../../src/backends/codex/rpc/client.js'
import { createCodexHub, type CodexHub } from '../../src/backends/codex/rpc/hub.js'
import { openCodexSession } from '../../src/backends/codex/session/session.js'
import { createFakeAppServer, NO_REPLY, type FakeAppServer } from './codex-fake-app-server.js'

type Rec = Record<string, unknown>
export const THREAD = '019a0000-0000-7000-8000-000000000001'
export const CWD = '/TMP/cwd'

export const tick = (ms = 0): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/** A manual clock: `advance(ms)` fires what is due. */
export function manualClock(): RpcClock & { advance(ms: number): void } {
  let now = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  let next = 1
  return {
    setTimeout: (callback, ms) => { const id = next++; timers.set(id, { at: now + ms, callback }); return id },
    clearTimeout: handle => { timers.delete(handle as number) },
    advance(ms) {
      now += ms
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (timer.at <= now) { timers.delete(id); timer.callback() }
    },
  }
}

/** A `thread/start`-shaped answer. */
export function threadAnswer(overrides: Rec = {}): Rec {
  return {
    thread: { id: THREAD, cwd: CWD, status: { type: 'idle' }, name: null, modelProvider: 'relay', model: 'gpt-5.6-terra', turns: [], source: 'vscode' },
    model: 'gpt-5.6-terra',
    modelProvider: 'relay',
    cwd: CWD,
    approvalPolicy: 'on-request',
    sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    reasoningEffort: 'low',
    ...overrides,
  }
}

export interface SessionHarness {
  readonly fake: FakeAppServer
  readonly hub: CodexHub
  readonly session: AgentSession
  readonly clock: ReturnType<typeof manualClock>
  readonly batches: { events: readonly AgentEvent[]; meta: AgentEventMeta }[]
  readonly events: () => AgentEvent[]
  /** Requests the client sent with this method, oldest first. */
  sent(method: string): Rec[]
  /** Server side of a turn start: `turn/started` + the user message item. */
  startTurn(turnId: string, clientId: string, text: string): Promise<void>
  /** `turn/completed` with a status. */
  completeTurn(turnId: string, status?: string): Promise<void>
  /** A notification for the thread. */
  notify(method: string, params: Rec): Promise<void>
  readonly debug: string[]
}

export async function openHarness(options: { readonly prefs?: CodexPrefsData; readonly resume?: Rec; readonly autoTurns?: boolean; readonly forceSettleMs?: number } = {}): Promise<SessionHarness> {
  const fake = createFakeAppServer()
  let turnCounter = 0
  const clock = manualClock()
  const debug: string[] = []
  const hub = createCodexHub({ executable: '/fake/codex', args: ['app-server'], env: {}, cwd: CWD }, { transportFactory: fake.transportFactory, clock, debug: line => debug.push(line) })
  await hub.ready
  fake.on('thread/start', () => threadAnswer())
  fake.on('thread/resume', () => options.resume ?? threadAnswer())
  fake.on('thread/unsubscribe', () => ({ status: 'unsubscribed' }))
  fake.on('turn/interrupt', () => ({}))
  fake.on('turn/steer', params => ({ turnId: params.expectedTurnId }))
  // turn/start answers with a fresh turn id; the test scripts the notifications.
  fake.on('turn/start', (_params, request) => {
    turnCounter += 1
    const id = `turn-${turnCounter}`
    fake.reply(request.id, { turn: { id, items: [], status: 'inProgress', itemsView: 'notLoaded' } })
    return NO_REPLY
  })
  const session = await openCodexSession({
    hub,
    release: hub.retain(),
    target: options.resume === undefined ? { kind: 'create', cwd: CWD } : { kind: 'resume', sessionId: THREAD },
    cwd: CWD,
    prefs: memoryCodexPrefs(options.prefs ?? {}),
    executable: { path: '/fake/codex', source: 'env', version: '0.160.1' },
    host: { debug: line => debug.push(line) },
    clock,
    forceSettleMs: options.forceSettleMs ?? 15_000,
  })
  const batches: { events: readonly AgentEvent[]; meta: AgentEventMeta }[] = []
  session.subscribe((events, meta) => { batches.push({ events, meta }) })
  await tick()
  const notify = async (method: string, params: Rec): Promise<void> => {
    fake.notify(method, { threadId: THREAD, ...params })
    await tick()
  }
  return {
    fake,
    hub,
    session,
    clock,
    batches,
    debug,
    events: () => batches.flatMap(batch => batch.events),
    sent: method => fake.requests.filter(request => request.method === method).map(request => request.params),
    async startTurn(turnId, clientId, text) {
      await notify('turn/started', { turn: { id: turnId, items: [], status: 'inProgress' } })
      const item = { type: 'userMessage', id: `item-${clientId}`, clientId, content: [{ type: 'text', text, text_elements: [] }] }
      await notify('item/started', { turnId, item })
      await notify('item/completed', { turnId, item })
    },
    async completeTurn(turnId, status = 'completed') {
      await notify('turn/completed', { turn: { id: turnId, items: [], status, error: null } })
    },
    notify,
  }
}
