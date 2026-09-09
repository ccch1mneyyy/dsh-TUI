/** Host-owned in-process Channel contract. No runtime or upstream imports. */


/**
 * Spinner presentation phase: the stage of the current turn the spinner
 * should convey.
 */
export type SpinnerMode =
  | 'requesting'
  | 'thinking'
  | 'responding'
  | 'tool-use'
  | 'tool-input'

/** Background treatment applied to tool-call cards. */
export type ToolBackground = 'none' | 'subtle' | 'strong'

/**
 * What the fullscreen transcript's right gutter shows:
 *  - `timeline`: Grok-style turn rail — one tick per user turn (conversation
 *    order, not scroll proportion), active turn highlighted, click to jump;
 *  - `scrollbar`: classic proportional thumb — position/size of the visible
 *    window over the whole content, click the track to scroll there;
 *  - `hidden`: no gutter; the transcript takes the full width.
 */
export type ScrollGutterMode = 'timeline' | 'scrollbar' | 'hidden'

/** A stored page-margin setting: a preset name or a custom spec. */
export type PageMarginSetting = PageMarginMode | PageMarginSpec

/**
 * Root page inset (settings `dsh-tui.pageMargin`): some terminals carry
 * their own viewport padding (Windows Terminal's 8px default, GUI
 * emulators), others — bare WSL, tmux, SSH — have none, so the UI text
 * touches the screen edges. A setting is either a preset name
 * (none/slim/normal/roomy) or a custom spec (see {@link PageMarginSpec}).
 * The resolved geometry is what `PageMargin` (the root inset box above
 * Chat) renders; the channel carries the setting for tests, the module
 * store below is what the box itself subscribes to (the channel's version
 * bump only re-renders below Chat).
 */
export type PageMarginMode = 'none' | 'slim' | 'normal' | 'roomy'

/** Custom spec: `NxM` — N blank columns per side, M blank rows top/bottom
 *  (e.g. `3x1`). */
export type PageMarginSpec = `${number}x${number}`

/** Individually selectable fields in the status footer. */
export interface StatusBarConfig {
  /** Prefer the compact, single-line presentation when space permits. */
  compact: boolean
  /** Live model id. */
  model: boolean
  /** Reasoning effort / thinking mode. */
  thinking: boolean
  /** Session working directory. */
  cwd: boolean
  /** Current context-window consumption. */
  contextUsage: boolean
  /** Prompt-cache hit rate. */
  cache: boolean
  /** Running input/output token totals. */
  tokens: boolean
  /** Estimated session spend (≈¥, DeepSeek official pricing — only shown
   *  for official DeepSeek providers whose model has a known price). */
  cost: boolean
  /** Live and recent output speed. */
  tps: boolean
  /** Current git branch. */
  gitBranch: boolean
  /** Current session title. */
  sessionTitle: boolean
  /** Short session id (# + first 8 chars), matching the session log filename. */
  sessionId: boolean
  /** Compact goal chip (phase glyph + rounds) while a goal exists. */
  goal: boolean
  /** Non-default session mode. */
  mode: boolean
  /** Segmented context progress bar on its own footer row. */
  contextBar: boolean
  /** Idle working-activity summary. */
  activity: boolean
  /** Mini trajectory wake rendered at the footer's right edge. */
  trajectory: boolean
  /** Idle `? for shortcuts` reminder; shortcut keys remain available when hidden. */
  shortcutHint: boolean
}

export interface SessionModeSpec {
  /** Stable id; also the display name unless `label` is set or the id is a
   *  localized built-in (`default`/`plan`/`full`). */
  id: string
  /** Optional display label; wins over the built-in i18n name. */
  label?: string
  /** Plan mode on/off (dsh-plan-mode `/plan`). */
  plan?: boolean
  /** Sandbox mode override (dsh-sandbox-policy `sandbox/mode`). */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Approval policy override (dsh-user-approval `approval/policy`). */
  approval?: 'ask' | 'never'
  /** Durable DSH permission preset identity (`permission/preset`). */
  permission?: string
}
