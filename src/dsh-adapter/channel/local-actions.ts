import { t } from '../../i18n.js'
import { snapshotLiveSessionEvents } from '../compat/liveSession.js'
import { listDirectChildren, type SubagentsServiceView } from './subagent-projection.js'
import type { foldBack as FoldBack } from './transcript.js'
import type { ChannelState, ToolViewPresenter } from './types.js'

export { setActivityFrames } from './core/local-actions.js'

/**
 * The DSH halves of the local actions (the backend-neutral ones live in
 * core/local-actions.ts): restoring folded rows from the DSH session log,
 * and the live subagent roster query.
 */
export function createLocalActions(deps: {
  ctx: { get(name: string): unknown }
  owner: { current(): boolean }
  binding: {
    capture(): unknown
    isCurrent(capture: unknown): boolean
    readonly agent: { session: unknown }
  }
  state: ChannelState
  presenters: ToolViewPresenter
  foldBack: typeof FoldBack
}) {
  const { ctx, owner, binding, state, foldBack } = deps
  const current = (capture: unknown): boolean => owner.current() && binding.isCurrent(capture)
  return {
    /** The history slicer behind "load earlier": restores folded rows from
     *  the durable DSH log (the core emits when anything came back). */
    loadOlder(): number {
      return foldBack(state.rows, snapshotLiveSessionEvents(binding.agent.session), deps.presenters)
    },
    async listSubagents(): Promise<string[]> {
      const service = ctx.get('subagents') as SubagentsServiceView | undefined
      if (!service) return [t('subagent-not-mounted')]
      const capture = binding.capture()
      try {
        const children = await listDirectChildren(service, String((binding.agent.session as { id?: unknown }).id))
        if (!current(capture)) throw new Error('dsh-tui: Channel lifetime has ended')
        if (children.length === 0) return [t('subagent-none')]
        return children.map(child => {
          const id = child.id
          // The host's non-running activity is not proof that a child was
          // archived: continuable children can be idle or temporarily unknown.
          // Prefer the live projection when this process still owns the run.
          const running = state.subagents.some(sub => sub.agentId === id && sub.status === 'running')
          const activity = running || child.activity === 'running' ? t('subagent-running') : t('subagent-unknown')
          // rc.2 names the child (`reviewer/checker`), the addressable locator;
          // a historical row has no name and keeps the short id.
          const locator = child.name !== undefined && child.name !== '' ? child.name : id.slice(0, 8)
          return t('subagent-row', { mode: child.mode === 'continuable' ? t('subagent-resumable') : t('subagent-oneshot'), label: child.label ? `「${child.label}」` : '', activity, id: locator })
        })
      } catch (error) {
        if (!current(capture)) throw error
        return [t('subagent-query-failed', { err: error instanceof Error ? error.message : String(error) })]
      }
    },
  }
}
