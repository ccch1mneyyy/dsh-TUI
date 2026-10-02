/**
 * Stable session identity across backends (docs/agent-backend-design.md §3.4).
 * A bare session id is only unique inside one backend's catalog, so every
 * cross-backend reference carries the backend id with it.
 */

/** One session of one backend. */
export interface AgentSessionRef {
  /** Backend id: `dsh`, `claude`, `acp:<agent>`. */
  readonly backendId: string
  /** The backend's own session id (DSH session id, Claude session uuid). */
  readonly sessionId: string
}

/** Backend assumed when a persisted reference carries no prefix. */
export const DEFAULT_BACKEND_ID = 'dsh'

/**
 * Serialize a reference as `<backendId>:<sessionId>`. DSH references
 * serialize WITHOUT a prefix, so every pre-multi-backend persisted id (MRU
 * lists, `--resume <id>`) stays valid as-is.
 */
export function formatSessionRef(ref: AgentSessionRef): string {
  return ref.backendId === DEFAULT_BACKEND_ID ? ref.sessionId : `${ref.backendId}:${ref.sessionId}`
}

/**
 * Parse {@link formatSessionRef} output. The backend id is the text before
 * the FIRST colon only when it names a known backend; any other string is a
 * bare DSH session id (DSH ids never need escaping this way).
 */
export function parseSessionRef(text: string, knownBackends: readonly string[]): AgentSessionRef {
  const colon = text.indexOf(':')
  if (colon > 0) {
    const backendId = text.slice(0, colon)
    if (backendId !== DEFAULT_BACKEND_ID && knownBackends.includes(backendId)) {
      return { backendId, sessionId: text.slice(colon + 1) }
    }
  }
  return { backendId: DEFAULT_BACKEND_ID, sessionId: text }
}

/** Value equality of two references. */
export function sameSessionRef(a: AgentSessionRef, b: AgentSessionRef): boolean {
  return a.backendId === b.backendId && a.sessionId === b.sessionId
}
