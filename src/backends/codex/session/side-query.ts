/** Ephemeral, read-only side answers; owned and cancelled with their session. */
import { randomUUID } from 'node:crypto'
import type { SessionCapabilities } from '../../../agent/capabilities.js'
import { t } from '../../../i18n.js'
import { errorText, rec, str } from '../narrow.js'
import { CLIENT, NOTIFY } from '../protocol/index.js'
import { RPC_ERROR, type RpcClock } from '../rpc/client.js'
import type { CodexHub, ThreadSink } from '../rpc/hub.js'
import type { SettingsSnapshot } from '../translate/live.js'

type Answer = { readonly answer: string | null; readonly error?: string }
export function createCodexSideQuery(deps: { readonly hub: CodexHub; readonly settings: SettingsSnapshot; readonly cwd: string; readonly clock: RpcClock; threadId(): string; closed(): boolean; debug(message: string): void }) {
  const active = new Set<AbortController>()
  let closed = false
  const cancelAll = (): void => { for (const controller of active) controller.abort() }
  const capability: NonNullable<SessionCapabilities['sideQuery']> = {
    async ask(prompt, options = {}) {
      if (options.signal?.aborted) return { answer: null }
      if (closed || deps.closed()) return { answer: null, error: t('codex-session-closed') }
      const owner = new AbortController()
      active.add(owner)
      const signal = options.signal === undefined ? owner.signal : AbortSignal.any([owner.signal, options.signal])
      let childId: string | undefined
      let turnId: string | undefined
      let detach: (() => void) | undefined
      let timer: unknown
      let settled = false
      let streamed = ''
      let answer = ''
      let finish!: (result: Answer) => void
      const result = new Promise<Answer>(resolve => { finish = value => { if (!settled) { settled = true; resolve(value) } } })
      const abort = (): void => {
        if (childId !== undefined && turnId !== undefined) void deps.hub.call(CLIENT.turnInterrupt, { threadId: childId, turnId }).catch(() => undefined)
        finish({ answer: null })
      }
      signal.addEventListener('abort', abort, { once: true })
      const run = async (): Promise<Answer> => {
        try {
          // Keep a late fork response observable so its temporary thread can
          // be unsubscribed after cancellation; never start a turn on it.
          const response = rec(await deps.hub.call(CLIENT.threadFork, {
            threadId: deps.threadId(), ephemeral: true, excludeTurns: true, deferGoalContinuation: true,
            cwd: deps.cwd, model: deps.settings.model, approvalPolicy: 'never', sandbox: 'read-only',
            developerInstructions: 'Answer the side question using the existing conversation. Do not call tools, modify files, create goals, or start agents. Give one concise answer.',
          }))
          childId = str(rec(response?.thread)?.id)
          if (childId === undefined) throw new Error(t('codex-side-open-failed'))
          if (signal.aborted || closed || deps.closed()) return { answer: null }
          const sink: ThreadSink = {
            notification(method, params) {
              if (settled || signal.aborted || closed || deps.closed()) return
              if (method === NOTIFY.turnStarted) turnId = str(rec(params.turn)?.id)
              if (method === NOTIFY.agentMessageDelta) {
                const delta = str(params.delta) ?? ''
                streamed += delta
                options.onText?.(delta)
              }
              if (method === NOTIFY.itemCompleted && rec(params.item)?.type === 'agentMessage') {
                answer = str(rec(params.item)?.text) ?? streamed
                if (streamed === '' && answer !== '') options.onText?.(answer)
              }
              if (method === NOTIFY.turnCompleted) {
                const turn = rec(params.turn)
                if (str(turn?.status) === 'failed') finish({ answer: null, error: str(rec(turn?.error)?.message) ?? t('codex-turn-failed') })
                else if (str(turn?.status) === 'interrupted') finish({ answer: null })
                else finish({ answer: answer || streamed })
              }
            },
            serverRequest(request) { request.respondError(RPC_ERROR.methodNotFound, 'side queries do not accept tool or approval requests') },
            connectionLost(error) { finish({ answer: null, error: errorText(error) }) },
            connectionRestored() {},
          }
          detach = deps.hub.attach(childId, sink)
          timer = deps.clock.setTimeout(abort, 120_000)
          const start = rec(await deps.hub.call(CLIENT.turnStart, {
            threadId: childId, clientUserMessageId: randomUUID(), input: [{ type: 'text', text: prompt, text_elements: [] }],
            approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false },
            model: deps.settings.model, effort: deps.settings.effort,
            collaborationMode: { mode: 'default', settings: { model: deps.settings.model, reasoning_effort: deps.settings.effort, developer_instructions: 'Answer only; do not use tools or execute the plan.' } },
          }))
          turnId ??= str(rec(start?.turn)?.id)
          if (signal.aborted || closed || deps.closed()) abort()
          return await result
        } catch (error) {
          return signal.aborted ? { answer: null } : { answer: null, error: errorText(error) }
        } finally {
          if (timer !== undefined) deps.clock.clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          detach?.()
          if (childId !== undefined) {
            try { await deps.hub.call(CLIENT.threadUnsubscribe, { threadId: childId }, { timeoutMs: 5000 }) }
            catch (error) { deps.debug(`codex: side query unsubscribe failed (${errorText(error)})`) }
          }
          active.delete(owner)
        }
      }
      const work = run()
      void work.then(finish)
      return Promise.race([work, result])
    },
  }
  return { capability, reset: cancelAll, close(): void { closed = true; cancelAll() } }
}
