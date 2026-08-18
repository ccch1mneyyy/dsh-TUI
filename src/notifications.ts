/**
 * Turn-notification domain: when the TUI asks the terminal for attention,
 * and which escape sequence it uses to ask.
 *
 * The preference itself is a plain display setting — it lives in the
 * `dsh-tui` settings namespace next to `diffLayout` (cordis.yml key +
 * `/settings` field), not in a `~/.dsh-tui` preference file.
 */

/**
 * When the TUI raises a notification.
 *
 * - `off` — never; no notification and no progress reporting.
 * - `unfocused` — only while the terminal window does not have focus.
 * - `always` — on every completed turn, focused or not.
 */
export type NotifyMode = 'off' | 'unfocused' | 'always'

/** The notification modes, in `/settings` display order. */
export const NOTIFY_MODES = ['off', 'unfocused', 'always'] as const

/**
 * The mode used when nothing is configured. Attention is only worth taking
 * when the user is looking somewhere else, so the default stays quiet for
 * anyone already watching the turn stream.
 */
export const DEFAULT_NOTIFY_MODE: NotifyMode = 'unfocused'

/**
 * Whether a value names a shipped notification mode.
 * @param value - Candidate mode.
 */
export function isNotifyMode(value: unknown): value is NotifyMode {
  return typeof value === 'string' && (NOTIFY_MODES as readonly string[]).includes(value)
}

/** The attention protocol used for one notification. */
export type NotifyChannel = 'iterm2' | 'kitty' | 'ghostty' | 'bell'

/**
 * Pick the notification protocol for an environment.
 *
 * Desktop-notification escape sequences are terminal-specific and there is
 * no capability query for them, so the emitter is chosen from the same
 * environment markers the renderer already trusts for terminal detection
 * (see ink/terminal.ts). WezTerm rides the iTerm2 branch: it implements the
 * same OSC 9 payload and reports no marker the other branches claim first.
 *
 * Anything unrecognized falls back to BEL, which every emulator understands
 * and which tmux turns into a window activity flag. Inside tmux/screen the
 * inner TERM is rewritten and TERM_PROGRAM is not always forwarded, so a
 * multiplexed session usually lands there — the multiplexer's own activity
 * flag is the honest signal in that case anyway.
 *
 * @param env - Environment to inspect (injectable for tests).
 * @returns The protocol to emit.
 */
export function pickNotifyChannel(env: NodeJS.ProcessEnv = process.env): NotifyChannel {
  const program = env.TERM_PROGRAM ?? ''
  if (program === 'ghostty' || env.GHOSTTY_RESOURCES_DIR !== undefined) return 'ghostty'
  if (env.TERM === 'xterm-kitty' || env.KITTY_WINDOW_ID !== undefined) return 'kitty'
  if (program === 'iTerm.app' || program === 'WezTerm') return 'iterm2'
  return 'bell'
}
