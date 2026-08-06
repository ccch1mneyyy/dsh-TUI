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
export const BULLET_OPERATOR = '∙';
export const TEARDROP_ASTERISK = '✻';
export const UP_ARROW = '\u2191'; // ↑
export const DOWN_ARROW = '\u2193'; // ↓
export const LIGHTNING_BOLT = '↯';
export const EFFORT_LOW = '○';
export const EFFORT_MEDIUM = '◐';
export const EFFORT_HIGH = '●';
export const EFFORT_MAX = '◉';
// Media/trigger status indicators
export const PLAY_ICON = '\u25b6'; // ▶
export const PAUSE_ICON = '\u23f8'; // ⏸
// MCP subscription indicators
export const REFRESH_ARROW = '\u21bb'; // ↻
export const CHANNEL_ARROW = '\u2190'; // ←
export const INJECTED_ARROW = '\u2192'; // →
export const FORK_GLYPH = '\u2442'; // ⑂
// Review status indicators
export const DIAMOND_OPEN = '\u25c7'; // ◇
export const DIAMOND_FILLED = '\u25c6'; // ◆
export const REFERENCE_MARK = '\u203b'; // ※
// Issue flag indicator
export const FLAG_ICON = '\u2691'; // ⚑
// Blockquote indicator
export const BLOCKQUOTE_BAR = '\u258e'; // ▎
export const HEAVY_HORIZONTAL = '\u2501'; // ━
// Bridge status indicators
export const BRIDGE_SPINNER_FRAMES = [
    '\u00b7|\u00b7',
    '\u00b7/\u00b7',
    '\u00b7\u2014\u00b7',
    '\u00b7\\\u00b7',
];
export const BRIDGE_READY_INDICATOR = '\u00b7\u2714\ufe0e\u00b7';
export const BRIDGE_FAILED_INDICATOR = '\u00d7';
//# sourceMappingURL=figures.js.map