import type { Context } from '@deepseek-ai/cordis'
import { t } from '../../i18n.js'
import { dispatchTuiDecision } from '../extension-events.js'
import type { TuiRewindMode } from '../extension-events.js'
import { normalizeRewindPromptDecision } from './decisions.js'
import type { ChatRow, ChannelState } from './types.js'

/** Narrow decision-only session action; fork mechanics remain separate. */
export function createRewindPromptAction(
  ctx: Context,
  deps: {
    agent(): object
    state(): Pick<ChannelState, 'agentId' | 'cwd'>
    withDecisionPending<T>(name: string, pending: Promise<T>): Promise<T>
    notify: ChannelState['notify']
  },
) {
  return async (row: ChatRow): Promise<{ modes: readonly TuiRewindMode[] } | 'cancel' | null> => {
    if (row.seq === undefined) return null
    const originAgent = deps.agent()
    const state = deps.state()
    const decision = await deps.withDecisionPending('tui/rewind-prompt', dispatchTuiDecision(ctx, 'tui/rewind-prompt', {
      text: row.text,
      seq: row.seq,
      sessionId: state.agentId,
      cwd: state.cwd,
    }, normalizeRewindPromptDecision))
    if (deps.agent() !== originAgent) {
      deps.notify(t('ext-stale-dropped'), { color: 'warning', timeoutMs: 4000 })
      return 'cancel'
    }
    if (decision === undefined) return null
    if ('cancel' in decision) {
      deps.notify(decision.reason ?? t('ext-action-cancelled'), { color: 'warning', timeoutMs: 4000 })
      return 'cancel'
    }
    return { modes: decision.modes }
  }
}
