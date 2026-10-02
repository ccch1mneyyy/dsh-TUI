/**
 * Backend registry contract (docs/agent-backend-design.md §3.4): how a
 * backend is detected, how a session is opened, and its offline catalog.
 */
import type { AgentSessionRef } from './refs.js'
import type { AgentSession } from './session.js'

/** What `detect()` found. Detection never throws: failures land here. */
export interface BackendDetection {
  readonly installed: boolean
  readonly authenticated?: boolean
  readonly version?: string
  /** A version outside the validated range (warn, never block). */
  readonly drift?: string
  /** How to install or sign in when unavailable. */
  readonly hint?: string
}

/** Which session to open. */
export type OpenTarget =
  | { readonly kind: 'create'; readonly cwd: string }
  | { readonly kind: 'resume'; readonly sessionId: string }
  | { readonly kind: 'fork'; readonly from: AgentSessionRef; readonly anchor?: string }

/** Host services a backend may use while detecting or opening. */
export interface BackendHost {
  readonly cwd: string
  /** Opt-in diagnostics; never stdout while the TUI renders. */
  debug(message: string): void
  /** User-visible warning (localized by the caller). */
  warn(message: string): void
}

/** One session row of an offline catalog. */
export interface SessionCatalogEntry {
  readonly ref: AgentSessionRef
  readonly title?: string
  readonly cwd?: string
  readonly updatedAt?: number
}

/** Offline session catalog (no session needs to be open). */
export interface SessionCatalog {
  list(cwd?: string): Promise<readonly SessionCatalogEntry[]>
  rename?(sessionId: string, title: string): Promise<void>
  delete?(sessionId: string): Promise<void>
}

/** One agent backend. */
export interface AgentBackend {
  /** `dsh` | `claude` | `acp:<agent>`. */
  readonly id: string
  readonly descriptor: { readonly label: string; readonly vendor: string; readonly version?: string; readonly brand?: 'neutral' }
  detect(host: BackendHost): Promise<BackendDetection>
  open(target: OpenTarget, host: BackendHost): Promise<AgentSession>
  readonly catalog?: SessionCatalog
}
