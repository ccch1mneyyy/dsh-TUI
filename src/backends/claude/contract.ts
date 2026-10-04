/**
 * Version contract of the Claude backend.
 * The SDK is pinned exactly (`package.json` optional peer + dev dependency);
 * the CLI it drives is validated per version read from
 * `system/init.claude_code_version`. Drift is reported (startup notice and a
 * `/doctor` line), never a hard stop: capability detection
 * (`init.capabilities`) decides behaviour, the version only explains it.
 */

/** Backend id of the Claude Agent backend (`AgentSessionRef.backendId`). */
export const CLAUDE_BACKEND_ID = 'claude'

/** User-facing backend name. Brand guidance allows "Claude Agent", never
 *  "Claude Code". */
export const CLAUDE_BACKEND_LABEL = 'Claude Agent'

/** How a user re-enters a Claude session from a shell: the launcher's
 *  backend flag plus the session id (DSH's `resume.txt` never holds one). */
export function claudeResumeCommand(sessionId: string): string {
  return `dsh-tui --backend claude --resume ${sessionId}`
}

/** The exact `@anthropic-ai/claude-agent-sdk` version this backend is
 *  validated against (mirrors the package.json pin). */
export const VALIDATED_SDK_VERSION = '0.3.287'

/** CLI versions validated with {@link VALIDATED_SDK_VERSION} (the SDK's own
 *  `manifest.json` parity version). */
export const VALIDATED_CLI_VERSIONS: readonly string[] = ['2.1.287']

/** Init capabilities this backend relies on when present (feature-detected,
 *  never version-sniffed). */
export const CLI_CAPABILITY = {
  /** `command_lifecycle` frames: user rows land on `started`. */
  lifecycle: 'msg_lifecycle_v1',
  /** `interrupt()` answers with `still_queued`. */
  interruptReceipt: 'interrupt_receipt_v1',
  /** `interrupt` honours `cancel_queued` (drop queued inputs with the turn). */
  interruptCancelQueued: 'interrupt_cancel_queued_v1',
} as const

/** The CLI version when it is outside the validated set, else undefined. */
export function cliVersionDrift(version: string | undefined): string | undefined {
  if (version === undefined || version === '') return undefined
  return VALIDATED_CLI_VERSIONS.includes(version) ? undefined : version
}

/** The SDK version when it differs from the pin, else undefined. */
export function sdkVersionDrift(version: string | undefined): string | undefined {
  if (version === undefined || version === '') return undefined
  return version === VALIDATED_SDK_VERSION ? undefined : version
}
