/**
 * OSC (Operating System Command) Types and Parser
 */
import type { Action, Color, TabStatusAction } from './types.js';
/** OSC introducer prefix: ESC followed by `]`. */
export declare const OSC_PREFIX: string;
/** String Terminator (ESC \) - alternative to BEL for terminating OSC */
export declare const ST: string;
/**
 * Generate an OSC sequence: ESC ] p1;p2;...;pN <terminator>.
 * Uses the ST terminator for Kitty (avoids beeps) and BEL for others.
 * @param parts - the sequence parts, joined by semicolons.
 * @returns the complete OSC sequence string.
 */
export declare function osc(...parts: (string | number)[]): string;
/**
 * Wrap an escape sequence for terminal multiplexer passthrough.
 * tmux and GNU screen intercept escape sequences; DCS passthrough
 * tunnels them to the outer terminal unmodified.
 *
 * tmux 3.3+ gates this behind `allow-passthrough` (default off). When off,
 * tmux silently drops the whole DCS — no junk, no worse than unwrapped OSC.
 * Users who want passthrough set it in their .tmux.conf; we don't mutate it.
 *
 * Do NOT wrap BEL: raw \x07 triggers tmux's bell-action (window flag);
 * wrapped \x07 is opaque DCS payload and tmux never sees the bell.
 * @param sequence - the escape sequence to wrap.
 * @returns the DCS-passthrough-wrapped sequence inside tmux or GNU screen,
 *   or the sequence unchanged otherwise.
 */
export declare function wrapForMultiplexer(sequence: string): string;
/**
 * Which path setClipboard() will take, based on env state. Synchronous so
 * callers can show an honest toast without awaiting the copy itself.
 *
 * - 'native': pbcopy (or equivalent) will run — high-confidence system
 *   clipboard write. tmux buffer may also be loaded as a bonus.
 * - 'tmux-buffer': tmux load-buffer will run, but no native tool — paste
 *   with prefix+] works. System clipboard depends on tmux's set-clipboard
 *   option + outer terminal OSC 52 support; can't know from here.
 * - 'osc52': only the raw OSC 52 sequence will be written to stdout.
 *   Best-effort; iTerm2 disables OSC 52 by default.
 *
 * pbcopy gating uses SSH_CONNECTION specifically, not SSH_TTY — tmux panes
 * inherit SSH_TTY forever even after local reattach, but SSH_CONNECTION is
 * in tmux's default update-environment set and gets cleared.
 */
export type ClipboardPath = 'native' | 'tmux-buffer' | 'osc52';
/**
 * Determine the clipboard path setClipboard() will take, based on env state.
 * @returns 'native' when a local clipboard tool is available, 'tmux-buffer'
 *   inside tmux, or 'osc52' otherwise.
 */
export declare function getClipboardPath(): ClipboardPath;
/**
 * Load text into tmux's paste buffer via `tmux load-buffer`.
 * -w (tmux 3.2+) propagates to the outer terminal's clipboard via tmux's
 * own OSC 52 emission. -w is dropped for iTerm2: tmux's OSC 52 emission
 * crashes the iTerm2 session over SSH.
 *
 * @param text - the text to load into the tmux paste buffer.
 * @returns true when the buffer was loaded successfully, false when not in
 *   tmux or the tmux command failed.
 */
export declare function tmuxLoadBuffer(text: string): Promise<boolean>;
/**
 * OSC 52 clipboard write: ESC ] 52 ; c ; <base64> BEL/ST
 * 'c' selects the clipboard (vs 'p' for primary selection on X11).
 *
 * When inside tmux ($TMUX set), `tmux load-buffer -w -` is the primary
 * path. tmux's buffer is always reachable — works over SSH, survives
 * detach/reattach, immune to stale env vars. The -w flag (tmux 3.2+) tells
 * tmux to also propagate to the outer terminal via its own OSC 52 path,
 * which tmux wraps correctly for the attached client. On older tmux, -w is
 * ignored and the buffer is still loaded. -w is dropped for iTerm2 (#22432)
 * because tmux's own OSC 52 emission (empty selection param: ESC]52;;b64)
 * crashes iTerm2 over SSH.
 *
 * After load-buffer succeeds, we ALSO return a DCS-passthrough-wrapped
 * OSC 52 for the caller to write to stdout. Our sequence uses explicit `c`
 * (not tmux's crashy empty-param variant), so it sidesteps the #22432 path.
 * With `allow-passthrough on` + an OSC-52-capable outer terminal, selection
 * reaches the system clipboard; with either off, tmux silently drops the
 * DCS and prefix+] still works. See Greg Smith's "free pony" in
 * https://anthropic.slack.com/archives/C07VBSHV7EV/p1773177228548119.
 *
 * If load-buffer fails entirely, fall through to raw OSC 52.
 *
 * Outside tmux, write raw OSC 52 to stdout (caller handles the write).
 *
 * Local (no SSH_CONNECTION): also shell out to a native clipboard utility.
 * OSC 52 and tmux -w both depend on terminal settings — iTerm2 disables
 * OSC 52 by default, VS Code shows a permission prompt on first use. Native
 * utilities (pbcopy/wl-copy/xclip/xsel/clip.exe) always work locally. Over
 * SSH these would write to the remote clipboard — OSC 52 is the right path there.
 *
 * @param text - the text to place on the clipboard.
 * @returns the sequence for the caller to write to stdout (raw OSC 52
 *   outside tmux, DCS-wrapped inside).
 */
export declare function setClipboard(text: string): Promise<string>;
/**
 * Reset the cached Linux clipboard tool probe, forcing the next copy to
 * re-probe wl-copy/xclip/xsel.
 * @internal test-only
 */
export declare function _resetLinuxCopyCache(): void;
/**
 * OSC command numbers
 */
export declare const OSC: {
    readonly SET_TITLE_AND_ICON: 0;
    readonly SET_ICON: 1;
    readonly SET_TITLE: 2;
    readonly SET_COLOR: 4;
    readonly SET_CWD: 7;
    readonly HYPERLINK: 8;
    readonly ITERM2: 9;
    readonly SET_FG_COLOR: 10;
    readonly SET_BG_COLOR: 11;
    readonly SET_CURSOR_COLOR: 12;
    readonly CLIPBOARD: 52;
    readonly KITTY: 99;
    readonly RESET_COLOR: 104;
    readonly RESET_FG_COLOR: 110;
    readonly RESET_BG_COLOR: 111;
    readonly RESET_CURSOR_COLOR: 112;
    readonly SEMANTIC_PROMPT: 133;
    readonly GHOSTTY: 777;
    readonly TAB_STATUS: 21337;
};
/**
 * Parse an OSC sequence into an action.
 *
 * @param content - The sequence content (without ESC ] and terminator).
 * @returns the parsed action; unrecognized commands yield an
 *   unknown-sequence action.
 */
export declare function parseOSC(content: string): Action | null;
/**
 * Parse an XParseColor-style color spec into an RGB Color.
 * Accepts `#RRGGBB` and `rgb:R/G/B` (1–4 hex digits per component, scaled
 * to 8-bit). Returns null on parse failure.
 * @param spec - the color spec string to parse.
 * @returns the parsed RGB color, or null when the spec does not match.
 */
export declare function parseOscColor(spec: string): Color | null;
/**
 * Start a hyperlink (OSC 8). Auto-assigns an id= param derived from the URL
 * so terminals group wrapped lines of the same link together (the spec says
 * cells with matching URI *and* nonempty id are joined; without an id each
 * wrapped line is a separate link — inconsistent hover, partial tooltips).
 * Empty url = close sequence (empty params per spec).
 * @param url - the link target URL; an empty string emits the close sequence.
 * @param params - optional OSC 8 parameters, merged over the auto-assigned id.
 * @returns the OSC 8 sequence.
 */
export declare function link(url: string, params?: Record<string, string>): string;
/** End a hyperlink (OSC 8) */
export declare const LINK_END: string;
/** iTerm2 OSC 9 subcommand numbers */
export declare const ITERM2: {
    readonly NOTIFY: 0;
    readonly BADGE: 2;
    readonly PROGRESS: 4;
};
/** Progress operation codes (for use with ITERM2.PROGRESS) */
export declare const PROGRESS: {
    readonly CLEAR: 0;
    readonly SET: 1;
    readonly ERROR: 2;
    readonly INDETERMINATE: 3;
};
/**
 * Clear iTerm2 progress bar sequence (OSC 9;4;0;BEL)
 * Uses BEL terminator since this is for cleanup (not runtime notification)
 * and we want to ensure it's always sent regardless of terminal type.
 */
export declare const CLEAR_ITERM2_PROGRESS: string;
/**
 * Clear terminal title sequence (OSC 0 with empty string + BEL).
 * Uses BEL terminator for cleanup — safe on all terminals.
 */
export declare const CLEAR_TERMINAL_TITLE: string;
/** Clear all three OSC 21337 tab-status fields. Used on exit. */
export declare const CLEAR_TAB_STATUS: string;
/**
 * Gate for emitting OSC 21337 (tab-status indicator). Ant-only while the
 * spec is unstable. Terminals that don't recognize it discard silently, so
 * emission is safe unconditionally — we don't gate on terminal detection
 * since support is expected across several terminals.
 *
 * Callers must wrap output with wrapForMultiplexer() so tmux/screen
 * DCS-passthrough carries the sequence to the outer terminal.
 * @returns true when the current user is Ant, the only environment emitting
 *   OSC 21337 today.
 */
export declare function supportsTabStatus(): boolean;
/**
 * Emit an OSC 21337 tab-status sequence. Omitted fields are left unchanged
 * by the receiving terminal; `null` sends an empty value to clear.
 * `;` and `\` in status text are escaped per the spec.
 * @param fields - the tab-status fields to emit; omitted fields are left
 *   unchanged by the terminal, null values clear the field.
 * @returns the OSC 21337 sequence.
 */
export declare function tabStatus(fields: TabStatusAction): string;
//# sourceMappingURL=osc.d.ts.map