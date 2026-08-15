/**
 * Cross-platform modifier-key helpers. Windows/Linux muscle memory uses
 * Ctrl+<key>; on macOS the same action maps to Cmd+<key>. Terminals deliver
 * Cmd as the `super` flag (kitty CSI-u / xterm modifyOtherKeys — see
 * src/ink/parse-keypress.ts); Ctrl keeps working everywhere, so `isMod`
 * accepts either on the mac and stays Ctrl-only elsewhere.
 */

export const isMac = process.platform === 'darwin'

/** True when the key event carries the platform's "primary" modifier. */
export function isMod(key: { ctrl?: boolean; super?: boolean }): boolean {
  return !!key.ctrl || (isMac && !!key.super)
}

/**
 * Display prefix for shortcut labels: "⌘" on macOS (Apple style, no "+"),
 * "ctrl+" everywhere else. Pair with the bare key, e.g. `${modLabel}o`.
 */
export const modLabel = isMac ? '⌘' : 'ctrl+'

/**
 * Modal-confirm guard. Since #110 the input pipeline can deliver Enter WITH
 * modifiers: Option+Enter arrives as meta+return (ESC CR), and on
 * extended-keys terminals (kitty CSI-u / modifyOtherKeys) Shift/Ctrl+Enter
 * arrive as return+modifier. A bare `key.return` in a decision dialog would
 * let those commit by accident — approving a permission escalation or
 * confirming an irreversible session delete when the user only wanted a
 * newline. Only a modifier-free Enter may commit a modal.
 */
export function isPlainReturn(key: {
  return?: boolean
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  super?: boolean
}): boolean {
  return !!key.return && !key.ctrl && !key.meta && !key.shift && !key.super
}

/**
 * Modal Enter recognition across parsed key events and Windows ConPTY's raw
 * CR/LF fallback. PromptInput already handled both forms; shared modal
 * pickers must do the same or their UI can render while Enter appears inert.
 */
export function isPlainReturnInput(
  input: string,
  key: Parameters<typeof isPlainReturn>[0] & { isPasted?: boolean },
): boolean {
  if (isPlainReturn(key)) return true
  // Bracketed paste can deliver a chunk that is all line breaks — that is
  // pasted content, not an Enter press, and must never confirm a modal.
  if (key.isPasted === true) return false
  return /^[\r\n]+$/u.test(input)
    && !key.ctrl && !key.meta && !key.shift && !key.super
}
