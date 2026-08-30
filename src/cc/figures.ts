/**
 * UI glyph constants used across the TUI: prompt markers, status badges,
 * direction arrows, media controls, reasoning-effort indicators, and
 * bridge-state symbols.
 *
 * Every constant is a fixed Unicode character, so rendering is identical on
 * all platforms except the activity bullet: macOS gets a heavier ring glyph
 * that matches its default terminal font, everything else gets a solid dot.
 * Escapes are used instead of raw characters so the file stays robust to
 * encoding round-trips; the rendered glyph is shown in each comment.
 */

/** Activity bullet: ring on macOS (`⏺`), solid dot elsewhere (`●`). */
export const BLACK_CIRCLE = process.platform === 'darwin' ? '⏺' : '●'

// Prompt and list markers
/** Prompt pointer, a bold right chevron (`❯`). */
export const POINTER = '\u276f' // ❯
/** Success checkmark (`✓`). */
export const TICK = '\u2713' // ✓
/** Small dot for separating operators (`∙`). */
export const BULLET_OPERATOR = '\u2219' // ∙
/** Settled tool-status dot, smaller than the running pulse (`•`). */
export const BULLET = '\u2022' // •
/** Failed tool status (`✗`). */
export const MULTIPLICATION_X = '\u2717' // ✗
/** Teardrop asterisk, decorative list marker (`✻`). */
export const TEARDROP_ASTERISK = '\u273b' // ✻
/** Lightning bolt, "fast / hot" marker (`↯`). */
export const LIGHTNING_BOLT = '\u21af' // ↯

// Direction arrows
/** Up arrow (`↑`). */
export const UP_ARROW = '\u2191' // ↑
/** Down arrow (`↓`). */
export const DOWN_ARROW = '\u2193' // ↓
/** Left arrow (`←`), channel indicator. */
export const CHANNEL_ARROW = '\u2190' // ←
/** Right arrow (`→`), injected-message indicator. */
export const INJECTED_ARROW = '\u2192' // →

// Reasoning-effort badges, from low to maximum
/** Low effort: open circle (`○`). */
export const EFFORT_LOW = '\u25cb' // ○
/** Medium effort: half-filled circle (`◐`). */
export const EFFORT_MEDIUM = '\u25d0' // ◐
/** High effort: filled circle (`●`). */
export const EFFORT_HIGH = '\u25cf' // ●
/** Maximum effort: bullseye (`◉`). */
export const EFFORT_MAX = '\u25c9' // ◉

// Media transport controls
/** Play control (`▶`). */
export const PLAY_ICON = '\u25b6' // ▶
/** Pause control (`⏸`). */
export const PAUSE_ICON = '\u23f8' // ⏸

// Subscription and routing
/** Refresh arrow (`↻`), MCP subscription indicator. */
export const REFRESH_ARROW = '\u21bb' // ↻
/** Fork glyph (`⑂`), fork indicator. */
export const FORK_GLYPH = '\u2442' // ⑂

// Review status
/** Open diamond (`◇`), review status indicator. */
export const DIAMOND_OPEN = '\u25c7' // ◇
/** Filled diamond (`◆`), review status indicator. */
export const DIAMOND_FILLED = '\u25c6' // ◆
/** Steer pending indicator (`⟡`) — minimal modern diamond sparkle. */
export const STEER_ICON = '\u27e1' // ⟡
/** Queue pending indicator (`◇`) — minimal modern open diamond. */
export const QUEUE_ICON = DIAMOND_OPEN
/** Reference mark (`※`), reference indicator. */
export const REFERENCE_MARK = '\u203b' // ※

// Flag, quote, and rule markers
/** Flag icon (`⚑`), issue indicator. */
export const FLAG_ICON = '\u2691' // ⚑
/** Blockquote bar (`▎`), left one-quarter block. */
export const BLOCKQUOTE_BAR = '\u258e' // ▎
/** Heavy horizontal rule (`━`). */
export const HEAVY_HORIZONTAL = '\u2501' // ━
/** Instrument group rule (`│`) — HUD and footer clusters. */
export const GROUP_RULE = '\u2502' // │

// Bridge status
/** Bridge spinner frames: `·|·` → `·/·` → `·—·` → `·\·`. */
export const BRIDGE_SPINNER_FRAMES = [
  '\u00b7|\u00b7',
  '\u00b7/\u00b7',
  '\u00b7\u2014\u00b7',
  '\u00b7\\\u00b7',
]
/** Bridge ready indicator (`·✔︎·`). */
export const BRIDGE_READY_INDICATOR = '\u00b7\u2714\ufe0e\u00b7'
/** Bridge failed indicator (`×`). */
export const BRIDGE_FAILED_INDICATOR = '\u00d7'

// Thinking spinner (Kimi Code style braille cycle, shown while reasoning
// streams; the settled chevron takes over once the step settles). Frames and
// the settled mark are both 1 column so the label does not jump on settle.
export const THINKING_SPINNER_FRAMES = [
  '\u280b', // ⠋
  '\u2819', // ⠙
  '\u2839', // ⠹
  '\u2838', // ⠸
  '\u283c', // ⠼
  '\u2834', // ⠴
  '\u2826', // ⠦
  '\u2827', // ⠧
  '\u2807', // ⠇
  '\u280f', // ⠏
]
export const THINKING_SPINNER_INTERVAL_MS = 80
/** Thinking settled marker: single-angle chevron (`›`) — quiet, 1 column. */
export const THINKING_SETTLED_MARKER = '\u203a' // ›
/** Activity turn-token mark (`▸`) — geometric stand-in for the fire emoji. */
export const ACTIVITY_TOKEN_MARK = '\u25b8' // ▸
