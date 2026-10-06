/** Dependencies and start-up facts of one Codex session (a thread). */
import type { OpenTarget } from '../../../agent/backend.js'
import type { CodexModeId } from '../modes.js'
import type { CodexPrefs } from '../prefs.js'
import type { RpcClock } from '../rpc/client.js'
import type { CodexExecutable } from '../rpc/binary.js'
import type { CodexHub } from '../rpc/hub.js'

export interface CodexSessionDeps {
  /** The shared connection (already retained for this session). */
  readonly hub: CodexHub
  /** Give the session's retain back (the last one starts the idle close). */
  readonly release: () => void
  readonly target: OpenTarget
  /** Where a created thread runs (a resumed one keeps its own). */
  readonly cwd: string
  readonly prefs: CodexPrefs
  readonly executable: CodexExecutable & { readonly version?: string }
  readonly host: {
    debug(message: string): void
  }
  /** Notices to show once the channel subscribes (start-time findings). */
  readonly startNotices?: readonly string[]
  /** Facts `/doctor` reports beside the session's own. */
  readonly doctor?: { readonly bubblewrapMissing?: boolean }
  readonly clock?: RpcClock
  /** Wall clock for event times (fixtures inject one). */
  readonly now?: () => number
  /** How long an interrupt may go unanswered before the turn is closed here. */
  readonly forceSettleMs?: number
}

/** The thread settings a session opened with (from the start/resume answer). */
export interface OpenedThread {
  readonly threadId: string
  readonly cwd: string
  readonly model: string
  readonly provider: string
  readonly effort: string | null
  readonly modeId: CodexModeId | 'custom'
  readonly title?: string
  /** `active` when a resumed thread is mid-turn. */
  readonly running: boolean
}
