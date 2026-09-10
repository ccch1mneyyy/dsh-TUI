import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { ensureLegacySessionEventTypes } from './sessionLog.js'

interface StoredSession {
  readonly meta: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly inheritedEventCount?: number
}

/** Read-only persistence seam for legacy services and per-session handles. */
export interface SessionReader {
  load?(id: SessionId): Promise<StoredSession>
  open?(id: SessionId, access: 'read'): Promise<{
    readonly header: SessionHeader
    readonly inheritedEventCount?: number
    read(): Promise<{ readonly events: readonly SessionEvent[] }>
    close(): Promise<void>
  }>
}

export async function readPersistedSession(source: SessionReader, id: SessionId): Promise<StoredSession> {
  ensureLegacySessionEventTypes()
  if (typeof source.open === 'function') {
    const handle = await source.open(id, 'read')
    try {
      const { events } = await handle.read()
      return { meta: handle.header, events, inheritedEventCount: handle.inheritedEventCount }
    } finally {
      await handle.close()
    }
  }
  if (typeof source.load === 'function') return source.load(id)
  throw new Error('dsh-tui: session persistence has no read API')
}
