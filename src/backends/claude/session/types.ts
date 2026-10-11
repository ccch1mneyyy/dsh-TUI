/** Dependencies and live query handles for a Claude session. */
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { BackendLocale } from '../../../agent/backend.js'
import type { ClaudeAuthPlan } from '../auth.js'
import type { StartPermissionMode } from '../options.js'
import type { ClaudeExecutable } from '../process.js'
import type { ClaudePrefs } from '../prefs.js'
import type { ClaudeChannels } from '../channels.js'
import type { ClaudeChannelTokens } from '../../shared/channel-tokens.js'
import type { ClaudeReplay } from '../replay.js'
import type { ClaudeSdkModule, ClaudeSessionStoreSdk } from '../sdk.js'
import type { FlagSettingsFile } from '../flag-settings.js'
import type { createInbox } from './input.js'

/** Timer seam (tests inject a manual clock). */
export interface ClaudeClock {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ClaudeSessionDeps {
  readonly sdk: Pick<ClaudeSdkModule, 'query'>
  /** The session-store API behind `/fork` and the conversation rewind
   *  (absent = neither capability). */
  readonly store?: Pick<ClaudeSessionStoreSdk, 'getSessionMessages' | 'forkSession'> & Partial<Pick<ClaudeSessionStoreSdk, 'renameSession' | 'getSubagentMessages'>>
  readonly cwd: string
  readonly sessionId: string
  /**
   * Resume this persisted session instead of creating one:
   * its replayed transcript is the session's `history()`, the first run
   * passes `resume` (never `sessionId`), and live numbering continues where
   * the replay ended.
   */
  readonly resume?: ClaudeReplay
  readonly start: StartPermissionMode
  readonly executable: ClaudeExecutable
  /** The child environment when no credential plan is given (tests). */
  readonly env: Record<string, string>
  /** The credential the session spawns with and how to renew it after an
   *  authentication failure (auth.ts). */
  readonly auth?: {
    readonly plan: ClaudeAuthPlan
    /** A fresh plan; `rejected` is the token the CLI just refused (renew it
     *  only if the store still holds that one), absent for `/login`. */
    renew(renewal: { readonly rejected?: string }): Promise<ClaudeAuthPlan>
    /** The user-facing sentence for a failed renewal (no error details). */
    failureNotice?(error: unknown): string
  }
  /** The user's persisted `/model` and `/effort` choices (memory if absent). */
  readonly prefs?: ClaudePrefs
  /** The relay channel profiles (channels.json; the file store if absent). */
  readonly channels?: ClaudeChannels
  /** The channel-token credential seam (shared/channel-tokens.ts; the file store
   *  under the DSH home if absent). Token material only ever moves between
   *  this seam and the spawn pipeline's env. */
  readonly channelTokens?: ClaudeChannelTokens
  /** A start model / effort when nothing is persisted (none = the CLI's). */
  readonly model?: string
  readonly effort?: string
  readonly host: {
    debug(message: string): void
    /** One child stderr line (deduplicated into notices by the host). */
    stderr?(line: string): void
    /** This backend's own data directory (`BackendHost.dataDir`). Absent = a
     *  host that keeps nothing for this backend: the prefs and channel stores
     *  stay in memory rather than a path this backend guessed (D2, B-3). */
    readonly dataDir?: string
    /** The language the TUI is showing, read live (B-3). */
    locale?(): BackendLocale
  }
  /** The installed SDK version (diagnostics). */
  readonly sdkVersion?: string
  /** Notices to show once the channel subscribes (start-time findings). */
  readonly startNotices?: readonly string[]
  readonly clock?: ClaudeClock
  /** How long a cancel may go unconfirmed before the turn is force-closed. */
  readonly forceSettleMs?: number
  /** Bound on `initializationResult()` (a CLI that never answers). */
  readonly initTimeoutMs?: number
  /** Bound on waiting for the consumer loop after `close()`. */
  readonly closeTimeoutMs?: number
  /** Bound on a `/login` reconnect waiting for the running turn (120 s). */
  readonly reconnectDeferMs?: number
}

/** One live `query()`: its stdin and its controller. A reconnect
 *  (credential renewal) replaces the run; the session, its id and the
 *  translator state stay. */
export interface Run {
  readonly inbox: ReturnType<typeof createInbox<SDKUserMessage>>
  readonly abortController: AbortController
  readonly query: ReturnType<ClaudeSessionDeps['sdk']['query']>
  /** The flag-settings file this run's CLI reads (flag-settings.ts). */
  readonly flagSettings?: FlagSettingsFile
  consumer: Promise<void>
}
