/**
 * Backend registry contract: how a backend is detected, how a session is
 * opened, and its offline catalog.
 */
import type { PreviewEntry, SessionSummary } from '../adapter/ports/channel-session.js'
import type { AgentSession } from './session.js'

/** What `detect()` found. Detection never throws: failures land here. */
export interface BackendDetection {
  readonly installed: boolean
  /**
   * Whether a credential the backend can use was found without a network
   * call: `unknown` when the backend cannot tell (a platform keychain).
   */
  readonly auth?: 'ok' | 'missing' | 'unknown'
  readonly version?: string
  /**
   * Not installed, yet a version was read: the CLI is there but older than
   * this backend supports (codex's "too old"). The picker then says "upgrade"
   * instead of "not installed", which is what the detection hint explains.
   * Replaces the host's `id === 'codex'` branch (P0 D5-2).
   */
  readonly stale?: true
  /** A version outside the validated range (warn, never block). */
  readonly drift?: string
  /** How to install or sign in when unavailable. */
  readonly hint?: string
  /**
   * A missing credential can be supplied after the session opened (the
   * backend's own `/login`): the kernel picker keeps the row selectable and
   * says to sign in after start, instead of dimming it.
   */
  readonly loginInSession?: true
}

/**
 * One-click install surface for an optional backend's SDK peer (the Claude
 * backend's wizard is the first consumer). These types live here so the UI
 * layer can read them without importing a backend package; the install
 * implementation itself stays inside the backend.
 */
export type SdkInstallTarget =
  | { readonly kind: 'profile'; readonly dir: string }
  | { readonly kind: 'standalone' }
  | { readonly kind: 'no-profile' }

/** How \u0060pnpm add\u0060 ended; \u0060tail\u0060 carries the captured output's last lines.
 *  \u0060ok.rebuiltStore\u0060 marks the self-healed path: pnpm reported
 *  ERR_PNPM_UNEXPECTED_STORE and the installer rebuilt node_modules under
 *  the pinned store before the add succeeded. */
export type SdkInstallResult =
  | { readonly kind: 'ok'; readonly rebuiltStore?: boolean }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'pnpm-missing' }
  | { readonly kind: 'failed'; readonly exitCode: number; readonly tail: readonly string[] }

/** A running install: `result` settles once, `cancel` kills the child. */
export interface SdkInstaller {
  readonly result: Promise<SdkInstallResult>
  readonly cancel: () => void
}

/**
 * The **data** half of an install surface: which of the host's install executors
 * to run, and what to hand it. A backend's manifest declares it
 * (`BackendManifest.install`) so the picker's wizard reads the target from the
 * registry entry instead of a host constant — the manifest describes, it does
 * not act.
 *
 * `executor` names a value of the host's table (`src/dsh-adapter/install/`), not
 * a backend: a recipe naming an executor this host does not implement is read as
 * "no install surface" (§6 item 12), which is what lets the set of values widen
 * without changing this shape.
 */
export interface BackendInstallRecipe {
  /** The host-side executor to run (`pnpm-profile-add`). */
  readonly executor: string
  /** `@scope/name@<version>`, as handed to `pnpm add`. */
  readonly specifier: string
  /** The validated version, shown in the confirm panel. */
  readonly version: string
}

/** The host's install wizard: the recipe above with its executor bound — the
 *  actions this surface carries are the ones its recipe's executor value means. */
export interface SdkInstallSurface extends BackendInstallRecipe {
  readonly resolveTarget: () => SdkInstallTarget
  readonly start: (dir: string) => SdkInstaller
  readonly preflight: () => Promise<boolean>
}

/** Which session to open. */
export type OpenTarget =
  | { readonly kind: 'create'; readonly cwd: string }
  /** A persisted session of this backend. `cwd` narrows where the backend
   *  looks for it (absent = the session's own recorded directory, else
   *  every project the backend knows). */
  | { readonly kind: 'resume'; readonly sessionId: string; readonly cwd?: string }

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
  fresh(options?: { readonly rejected?: string; readonly signal?: AbortSignal }): Promise<OAuthAccess | undefined>
  /** Whether a credential is stored, without touching the network. */
  stored(): Promise<boolean>
}

/** Host-owned credential refs; token material never enters events or logs. */
export interface BackendTokenStore {
  read(ref: string): string | undefined
  write(ref: string, value: string): void
  erase(ref: string): void
  declared(ref: string): boolean
}

/** Host services a backend may use while detecting or opening. */
export interface BackendHost {
  readonly cwd: string
  /** Stored channel tokens, when the host provides its credential service. */
  readonly tokenStore?: BackendTokenStore
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
  /** Omitted means deletion; archive keeps the backend's durable transcript. */
  readonly deleteAction?: 'archive'
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
  readonly descriptor: { readonly label: string }
  detect(host: BackendHost): Promise<BackendDetection>
  open(target: OpenTarget, host: BackendHost): Promise<AgentSession>
  readonly catalog?: SessionCatalog
  readonly launch?: {
    sessionPrefs(debug: (message: string) => void): BackendSessionPrefs
    resumeCommand(sessionId: string): string
  }
}
