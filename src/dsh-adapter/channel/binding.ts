import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { ChannelOwner } from './owner.js'

/** Sole writer of the attached Agent/handle identity and binding generation. */
export function createChannelBinding(initial: Agent, handle: AgentHandle | undefined, owner: ChannelOwner) {
  let currentAgent = initial
  let currentHandle = handle
  let generation = 0
  let subscriptions: (() => void)[] = []
  const clearSubscriptions = () => {
    for (const dispose of subscriptions.splice(0)) dispose()
  }
  owner.own(clearSubscriptions)
  return {
    get agent() { return currentAgent },
    get handle() { return currentHandle },
    get generation() { return generation },
    capture() { return { agent: currentAgent, generation } },
    isCurrent(capture: { agent: Agent; generation: number }) {
      return owner.current() && capture.agent === currentAgent && capture.generation === generation
    },
    assertPrepared(handle: AgentHandle, capture: { agent: Agent; generation: number }) {
      if (!owner.current() || capture.agent !== currentAgent || capture.generation !== generation) {
        void handle.dispose().catch(() => undefined)
        throw new Error('dsh-tui: Channel binding changed before adoption')
      }
    },
    async prepare(create: () => Promise<AgentHandle>): Promise<AgentHandle> {
      owner.assertActive()
      const origin = currentAgent
      const epoch = generation
      const prepared = await create()
      if (!owner.current() || origin !== currentAgent || epoch !== generation) {
        await prepared.dispose().catch(() => undefined)
        throw new Error('dsh-tui: Channel binding changed during preparation')
      }
      return prepared
    },
    replace(agent: Agent, handle: AgentHandle | undefined) {
      owner.assertActive()
      clearSubscriptions()
      currentAgent = agent
      currentHandle = handle
    },
    bind() {
      owner.assertActive()
      clearSubscriptions()
      generation += 1
      return generation
    },
    subscribe(dispose: () => void) { subscriptions.push(dispose) },
    clearSubscriptions,
  }
}
