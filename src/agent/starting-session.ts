/**
 * The session a channel holds while its real one is still opening: the
 * screen mounts against it, and the channel adopts the real session once the
 * backend's open settles.
 *
 * It serves nothing: no capabilities, an empty history, no events, and a
 * submit that is never delivered (the composer refuses to send while the
 * channel is not ready, so this is only a backstop).
 */
import type { AgentSessionRef } from './refs.js'
import type { AgentSession, AgentSessionStatus } from './session.js'

/** A placeholder session of `backendId` in `cwd`; its session id is empty. */
export function createStartingSession(backendId: string, cwd: string): AgentSession {
  const ref: AgentSessionRef = { backendId, sessionId: '' }
  let status: AgentSessionStatus = 'starting'
  return {
    ref,
    cwd,
    get status() { return status },
    capabilities: { native: {} },
    history: () => Promise.resolve([]),
    subscribe: () => () => undefined,
    submit: () => Promise.resolve({ accepted: false, reason: 'starting' }),
    cancel: () => Promise.resolve({ stillQueued: [], outcome: 'confirmed' }),
    dispose: () => {
      status = 'disposed'
      return Promise.resolve()
    },
  }
}
