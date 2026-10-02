/**
 * Side-panel geometry: the single source of truth for 'can we split, and
 * if so how wide is each column'. Pure functions only — the verify scripts
 * assert these tables directly at boundary widths.
 *
 * Anchors (side-panel design doc §4.2):
 * - CHAT_MIN_COLUMNS keeps the 2-col transcript gutter
 *   (RAIL_MIN_TERMINAL_WIDTH = 60 in ink/timeline-rail.ts) plus tool-card
 *   indentation readable;
 * - PANEL_MIN_COLUMNS is the narrowest width at which the Jobs panel
 *   variant stays legible;
 * - everything is derived from those minimums — never a hard-coded
 *   'columns < 100' style threshold.
 *
 * Widths are ALWAYS numeric (Math.floor): ink resolves % against the
 * padding-inclusive parent box, so a percentage column would lie (see
 * PageMargin.tsx's content-box comment).
 */

export const CHAT_MIN_COLUMNS = 64
export const PANEL_MIN_COLUMNS = 28
export const DIVIDER_COLUMNS = 1

/** Chat fraction of the content width when the user has not resized. */
export const DEFAULT_RATIO = 0.68

/** What zoom ASKS for (chat fraction); the chat column never goes below
 *  CHAT_MIN_COLUMNS, so the achieved ratio is usually larger. */
export const ZOOM_TARGET_RATIO = 0.20

/** Keyboard resize step (columns) for the panel-focused +/- bindings. */
export const RESIZE_STEP_COLUMNS = 4

/** Smallest content width at which a split keeps both sides usable. */
export function canSplit(columns: number): boolean {
  return columns >= CHAT_MIN_COLUMNS + PANEL_MIN_COLUMNS + DIVIDER_COLUMNS
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Feasible chat-fraction range for a content width (both ends inclusive). */
export function ratioRange(columns: number): { readonly min: number; readonly max: number } {
  if (columns <= 0) return { min: 0, max: 1 }
  return {
    min: Math.min(1, CHAT_MIN_COLUMNS / columns),
    max: Math.max(0, (columns - PANEL_MIN_COLUMNS - DIVIDER_COLUMNS) / columns),
  }
}

/** Clamp a stored ratio into the feasible range for this width. */
export function clampRatio(columns: number, ratio: number): number {
  const range = ratioRange(columns)
  return clamp(ratio, Math.min(range.min, range.max), range.max)
}

export interface SidePanelSplit {
  readonly chat: number
  readonly panel: number
}

/** Split geometry for a content width and chat fraction. */
export function resolveSplit(columns: number, ratio: number): SidePanelSplit {
  const chat = clamp(
    Math.floor(columns * ratio),
    CHAT_MIN_COLUMNS,
    columns - PANEL_MIN_COLUMNS - DIVIDER_COLUMNS,
  )
  return { chat, panel: columns - chat - DIVIDER_COLUMNS }
}

/** Zoom geometry: the panel takes over; chat keeps at least CHAT_MIN_COLUMNS. */
export function resolveZoom(columns: number): SidePanelSplit {
  return resolveSplit(columns, ZOOM_TARGET_RATIO)
}

export interface SidePanelGeometryInput {
  readonly columns: number
  readonly open: boolean
  readonly zoom: boolean
  readonly ratio: number
}

/**
 * Resolve the effective layout. null means 'no split' (chat takes the
 * full content width); callers render exactly as today in that case.
 */
export function resolveSidePanelGeometry(
  input: SidePanelGeometryInput,
): SidePanelSplit | null {
  const { columns, open, zoom, ratio } = input
  if (!open || !canSplit(columns)) return null
  return zoom ? resolveZoom(columns) : resolveSplit(columns, ratio)
}

/** Keyboard resize: shift the chat fraction by deltaColumns worth of
 *  width, clamped into the feasible range for this terminal. */
export function nudgeRatio(columns: number, ratio: number, deltaColumns: number): number {
  if (columns <= 0) return ratio
  return clampRatio(columns, ratio + deltaColumns / columns)
}
