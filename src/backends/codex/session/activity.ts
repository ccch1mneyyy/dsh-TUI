/** A compact working line driven by native thread notifications, not every token. */
import type { WorkingActivityView } from '../../../adapter/ports/channel-view.js'
import type { AgentEvent } from '../../../agent/events.js'
import { getLang, t } from '../../../i18n.js'
import { arr, rec, str, type Rec } from '../narrow.js'
import { NOTIFY } from '../protocol/index.js'
import type { RpcClock } from '../rpc/client.js'
import { commandTitle, unwrapCommand } from '../translate/commands.js'

export function createCodexActivity(deps: { readonly clock: RpcClock; now(): number; emit(events: readonly AgentEvent[]): void }) {
  const listeners = new Set<(view: WorkingActivityView) => void>()
  let view: WorkingActivityView = { phase: 'idle', line: '', live: false, toolCount: 0, phaseStartedAt: 0, turnStartedAt: 0, updatedAt: 0, lang: getLang() }
  let active = false
  let blocked = false
  let waiting: unknown
  let stalled: unknown
  let closed = false
  const set = (phase: WorkingActivityView['phase'], line: string): void => {
    if (closed || (view.phase === phase && view.line === line && view.lang === getLang())) return
    const now = deps.now()
    view = { ...view, phase, line, phaseStartedAt: phase === view.phase ? view.phaseStartedAt : now, updatedAt: now, lang: getLang() }
    for (const listener of listeners) listener(view)
  }
  const clearWait = (): void => {
    if (waiting !== undefined) deps.clock.clearTimeout(waiting)
    if (stalled !== undefined) deps.clock.clearTimeout(stalled)
    waiting = undefined
    stalled = undefined
  }
  const wait = (): void => {
    clearWait()
    if (!active || blocked || view.phase === 'tool') return
    waiting = deps.clock.setTimeout(() => set('waiting', t('codex-model-waiting')), 30_000)
    stalled = deps.clock.setTimeout(() => deps.emit([{ type: 'notice', level: 'warning', key: 'codex-model-stalled', text: t('codex-model-stalled') }]), 120_000)
  }
  return {
    capability: { subscribe(listener: (value: WorkingActivityView) => void): () => void { listeners.add(listener); listener(view); return () => { listeners.delete(listener) } } },
    notification(method: string, params: Rec): void {
      if (closed) return
      const now = deps.now()
      if (method === NOTIFY.turnStarted) {
        active = true
        blocked = false
        view = { ...view, toolCount: 0, turnStartedAt: now }
        set('waiting', t('codex-working-thinking'))
      } else if (method === NOTIFY.turnCompleted) {
        active = false
        blocked = false
        set('idle', '')
      } else if (method === NOTIFY.threadStatusChanged) {
        const status = rec(params.status)
        const flags = arr(status?.activeFlags)
        blocked = flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')
        if (str(status?.type) === 'idle') { active = false; set('idle', '') }
      } else if (method === NOTIFY.itemStarted) {
        const item = rec(params.item)
        switch (str(item?.type)) {
          case 'commandExecution': set('tool', t('codex-working-command', { command: commandTitle(unwrapCommand(str(item?.command) ?? '', item?.commandActions)) })); break
          case 'fileChange': set('tool', t('codex-working-files', { files: arr(item?.changes).map(raw => str(rec(raw)?.path) ?? '').join(', ') })); break
          case 'collabAgentToolCall': set('tool', t('codex-working-subagents')); break
          case 'mcpToolCall': set('tool', `${str(item?.server) ?? 'MCP'}.${str(item?.tool) ?? ''}`); break
          case 'webSearch': set('tool', str(item?.query) ?? ''); break
          case 'agentMessage':
          case 'reasoning':
          case 'plan': set('thinking', t('codex-working-thinking')); break
        }
      } else if (method === NOTIFY.itemCompleted) {
        const item = rec(params.item)
        // A completed commentary settles into the transcript as an assistant
        // message (translate §7.3): the working line must NOT keep narrating
        // its text — the same sentence would show twice at once, once under
        // the ⏵ spinner and once as the reply's first message. Claude's
        // narrated line differs there: it is a `⏵` line STRIPPED from the
        // transcript, so its working line never duplicates anything.
        if (str(item?.type) === 'agentMessage' && str(item?.phase) === 'commentary') {
          set('thinking', t('codex-working-thinking'))
        } else if (['commandExecution', 'fileChange', 'mcpToolCall', 'collabAgentToolCall', 'webSearch'].includes(str(item?.type) ?? '')) {
          view = { ...view, toolCount: view.toolCount + 1 }
          set('thinking', t('codex-working-thinking'))
        }
      }
      wait()
    },
    reset(): void { active = false; blocked = false; clearWait(); set('idle', '') },
    close(): void { active = false; clearWait(); set('idle', ''); closed = true; listeners.clear() },
  }
}
