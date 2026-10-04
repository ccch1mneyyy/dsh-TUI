/**
 * Backend registry contract: how a backend is detected, how a session is
 * opened, and its offline catalog.
 */
import type { PreviewEntry, SessionSummary } from '../adapter/ports/channel-session.js'
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
  /** A persisted session of this backend. `cwd` narrows where the backend
   *  looks for it (absent = the session's own recorded directory, else
   *  every project the backend knows). */
  | { readonly kind: 'resume'; readonly sessionId: string; readonly cwd?: string }
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
   * only while the store still holds that very token (compare-and-swap). A
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

/** Where an offline listing looks. */
export interface SessionListScope {
  /** The project directory (and its worktrees, where the backend groups
   *  them); absent = the host's working directory. */
  readonly cwd?: string
  /** Every project the backend knows (`cwd` is then ignored). */
  readonly allProjects?: boolean
}

/**
 * A backend's offline session catalog: no session needs to be open. Rows
 * are the browser's own `SessionSummary` shape with `backendId` set. The
 * backend's own store stays authoritative; the TUI indexes nothing beyond
 * what the catalog itself caches.
 */
export interface SessionCatalog {
  list(scope?: SessionListScope): Promise<readonly SessionSummary[]>
  /** One session's row, or undefined when the backend has no such session. */
  info?(sessionId: string, cwd?: string): Promise<SessionSummary | undefined>
  /** The trailing exchanges of a session (browser preview), newest last. */
  preview?(sessionId: string, options?: { readonly cwd?: string; readonly limit?: number }): Promise<readonly PreviewEntry[]>
  rename?(sessionId: string, title: string, cwd?: string): Promise<void>
  delete?(sessionId: string, cwd?: string): Promise<void>
}

/** Backend-scoped launcher marker and session browser usage notes. */
export interface BackendSessionPrefs {
  lastSession(): string | undefined
  setLastSession(sessionId: string): void
  touch(sessionId: string): void
  forget(sessionId: string): void
}

/** One agent backend. */
export interface AgentBackend {
  /** `dsh` | `claude` | `acp:<agent>`. */
  readonly id: string
  readonly descriptor: { readonly label: string; readonly vendor: string; readonly version?: string; readonly brand?: 'neutral' }
  detect(host: BackendHost): Promise<BackendDetection>
  open(target: OpenTarget, host: BackendHost): Promise<AgentSession>
  readonly catalog?: SessionCatalog
  readonly launch?: {
    sessionPrefs(debug: (message: string) => void): BackendSessionPrefs
    resumeCommand(sessionId: string): string
  }
}
