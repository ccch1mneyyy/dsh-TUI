import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { ChannelOwner } from './owner.js'

/** Owns temporary Agent handles until a caller explicitly transfers them. */
export function createDetachedHandleFactory(owner: Pick<ChannelOwner, 'assertActive' | 'current' | 'own'>) {
  return async (create: () => Promise<AgentHandle>): Promise<{
    handle: AgentHandle
    transfer(): void
    release(): Promise<void>
  }> => {
    owner.assertActive()
    let handle: AgentHandle | undefined
    let transferred = false
    let disposePromise: Promise<void> | undefined
    const release = (): Promise<void> => {
      if (transferred || handle === undefined) return Promise.resolve()
      disposePromise ??= handle.dispose().catch(() => undefined)
      return disposePromise
    }
    const unregister = owner.own(() => { void release() })
    try {
      handle = await create()
      if (!owner.current()) {
        await release()
        throw new Error('dsh-tui: Channel lifetime has ended')
      }
      return {
        handle,
        transfer() { transferred = true; unregister() },
        async release() { unregister(); await release() },
      }
    } catch (error) {
      unregister()
      await release()
      throw error
    }
  }
}
