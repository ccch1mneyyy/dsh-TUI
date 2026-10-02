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
  /**
   * Whether a credential the backend can use was found without a network
   * call: `unknown` when the backend cannot tell (a platform keychain).
   */
  readonly auth?: 'ok' | 'missing' | 'unknown'
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

/** A usable OAuth access token and its expiry (epoch ms). Token material:
 *  only ever handed to the backend's child process, never logged. */
export interface OAuthAccess {
  readonly access: string
  readonly expires: number
}

/** The host's stored OAuth login for one provider (dsh-auth on DSH hosts). */
export interface OAuthCredentialSource {
  /**
   * The stored credential, refreshed first when it is about to expire;
   * undefined when none is stored. Rejects when a needed refresh fails.
   *
   * `rejected` is the access token the backend just refused: it is refreshed
   * only while the store still holds that very token (compare-and-swap) — a
   * credential rotated meanwhile (a fresh `/login`, another process's
   * refresh) is returned as is, never force-refreshed.
   */
  fresh(options?: { readonly rejected?: string }): Promise<OAuthAccess | undefined>
  /** Whether a credential is stored, without touching the network. */
  stored(): Promise<boolean>
}

/** Host services a backend may use while detecting or opening. */
export interface BackendHost {
  readonly cwd: string
  /** Opt-in diagnostics; never stdout while the TUI renders. */
  debug(message: string): void
  /** User-visible warning (localized by the caller). */
  warn(message: string): void
  /** One line a backend child process wrote to stderr (never the terminal:
   *  the host logs it and folds repeats into notices). */
  stderr?(line: string): void
  /** The host's stored OAuth login for a provider id (`anthropic`), when the
   *  host keeps one. */
  oauthCredential?(provider: string): OAuthCredentialSource | undefined
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
