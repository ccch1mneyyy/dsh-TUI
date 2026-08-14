/**
 * UI glyph constants, ported from the leaked Claude Code source
 * (`src/constants/figures.ts`). The macOS/Windows variants from the original
 * are kept; the plugin renders on whatever platform the user runs.
 */
export const BLACK_CIRCLE = process.platform === 'darwin' ? '⏺' : '●';
/** The prompt pointer glyph (`❯`), figures.pointer. */
export const POINTER = '❯';
/** Checkmark (`✓`), figures.tick. */
export const TICK = '✓';
/** Bullet dot (`∙`), figures.bulletOperator. */
export const BULLET_OPERATOR = '∙';
/** Teardrop asterisk (`✻`), figures.teardropAsterisk. */
export const TEARDROP_ASTERISK = '✻';
/** Up arrow (`↑`). */
export const UP_ARROW = '\u2191'; // ↑
/** Down arrow (`↓`). */
export const DOWN_ARROW = '\u2193'; // ↓
/** Lightning bolt (`↯`), figures.lightningBolt. */
export const LIGHTNING_BOLT = '↯';
/** Low-effort indicator: open circle (`○`). */
export const EFFORT_LOW = '○';
/** Medium-effort indicator: half circle (`◐`). */
export const EFFORT_MEDIUM = '◐';
/** High-effort indicator: filled circle (`●`). */
export const EFFORT_HIGH = '●';
/** Max-effort indicator: bullseye (`◉`). */
export const EFFORT_MAX = '◉';
// Media/trigger status indicators
/** Play control icon (`▶`). */
export const PLAY_ICON = '\u25b6'; // ▶
/** Pause control icon (`⏸`). */
export const PAUSE_ICON = '\u23f8'; // ⏸
// MCP subscription indicators
/** Refresh arrow (`↻`), MCP subscription indicator. */
export const REFRESH_ARROW = '\u21bb'; // ↻
/** Left arrow (`←`), channel indicator. */
export const CHANNEL_ARROW = '\u2190'; // ←
/** Right arrow (`→`), injected-message indicator. */
export const INJECTED_ARROW = '\u2192'; // →
/** Fork glyph (`⑂`), fork indicator. */
export const FORK_GLYPH = '\u2442'; // ⑂
// Review status indicators
/** Open diamond (`◇`), review status indicator. */
export const DIAMOND_OPEN = '\u25c7'; // ◇
/** Filled diamond (`◆`), review status indicator. */
export const DIAMOND_FILLED = '\u25c6'; // ◆
/** Reference mark (`※`), reference indicator. */
export const REFERENCE_MARK = '\u203b'; // ※
// Issue flag indicator
/** Flag icon (`⚑`), issue indicator. */
export const FLAG_ICON = '\u2691'; // ⚑
// Blockquote indicator
/** Blockquote bar (`▎`), left one-quarter block. */
export const BLOCKQUOTE_BAR = '\u258e'; // ▎
/** Heavy horizontal rule (`━`). */
export const HEAVY_HORIZONTAL = '\u2501'; // ━
// Bridge status indicators
/** Bridge status spinner frames (`·|·`, `·/·`, `·—·`, `·\·`). */
export const BRIDGE_SPINNER_FRAMES = [
    '\u00b7|\u00b7',
    '\u00b7/\u00b7',
    '\u00b7\u2014\u00b7',
    '\u00b7\\\u00b7',
];
/** Bridge ready indicator (`·✔︎·`). */
export const BRIDGE_READY_INDICATOR = '\u00b7\u2714\ufe0e\u00b7';
/** Bridge failed indicator (`×`). */
export const BRIDGE_FAILED_INDICATOR = '\u00d7';
