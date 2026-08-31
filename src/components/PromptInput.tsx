import React from 'react'
import stripAnsi from 'strip-ansi'
import { readFile, unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { t } from '../i18n.js'
import { Box, Text, useInput, useTerminalSize, useTheme, type ScrollBoxHandle } from '../ui.js'
import { EffortChargeGlyph } from './EffortChargeGlyph.js'
import { EffortInputBorder, type InputBorderLabel } from './EffortInputBorder.js'
import { EffortTierBadge } from './EffortTierBadge.js'
import { isLightThemeActive } from '../theme.js'
import { sessionColorHex } from '../cc/sessionColors.js'
import { useDeclaredCursor } from '../ink/hooks/use-declared-cursor.js'
import type { ClickEvent } from '../ink/events/click-event.js'
import type { DragEvent } from '../ink/events/drag-event.js'
import { TerminalWriteContext } from '../ink/useTerminalNotification.js'
import { setClipboard } from '../ink/termio/osc.js'
import { noteAuxNumber } from '../ink/geometry-trace.js'
import instances from '../ink/instances.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../ink/truncateToWidth.js'
import { getGraphemeSegmenter } from '../utils/intl.js'
import { formatClipboardInsert, readClipboard } from '../utils/clipboard.js'
import { editInExternalEditor } from '../utils/externalEditor.js'
import { setPromptEditorNode, EditorButton } from './PromptEditor.js'
import type { Channel } from '../dsh-adapter/channel.js'
import { isHiddenCommandName, parseCommandName } from '../commands.js'
import { appendHistory } from '../history.js'
import { mentionAtCaret } from '../utils/mentions.js'
import { preserveSelection, type FileCandidate } from '../utils/fileSuggestions.js'
import { isMod } from '../utils/modifiers.js'
import { actionMatches } from '../utils/keymap.js'
import { CommandSuggestions } from './CommandSuggestions.js'
import { FileSuggestions } from './FileSuggestions.js'
import { HelpMenu } from './HelpMenu.js'
import { OverlayAbove } from './OverlayAbove.js'
import { SuggestionCard, cardContentWidth } from './SuggestionCard.js'

const HISTORY_LIMIT = 50

/**
 * Paste fold (CC-style collapse with a visible preview, no black box):
 * a paste that leaves the input this big folds into a one-line chip
 * showing the line/char count PLUS the first line of content. Hover peeks
 * at the full text (window pinned to the head); clicking the chip — or
 * the `▾` prefix on the first row while expanded — toggles the fold; Esc
 * or any editing key unfolds first. Enter still submits the FULL text:
 * folding never drops data.
 */
const FOLD_MIN_LINES = 6
const FOLD_MIN_CHARS = 600
const isBigInput = (text: string): boolean =>
  text.split('\n').length >= FOLD_MIN_LINES || text.length >= FOLD_MIN_CHARS

/**
 * Editable prompt text must have one stable source-to-screen geometry. The
 * renderer interprets ANSI as zero-width styling and expands tabs relative to
 * global tab stops; keeping either in `value` would let wrapping/click mapping
 * count different cells and could split an escape sequence during selection.
 * Strip terminal controls and expand tabs at ingress while preserving newlines.
 */
const EDITABLE_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/u

/** Normalize editable text so no terminal control characters remain in state. */
function sanitizeEditableText(text: string): string {
  // Fast path for ordinary and multi-line drafts: newline is intentionally
  // absent from the probe, so a large clean paste returns without regex work.
  if (!EDITABLE_CONTROL.test(text)) return text
  return stripAnsi(text)
    .replace(/\r\n?/gu, '\n')
    .replace(/\t/gu, '        ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
}

function clipboardImageMediaType(path: string): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  if (/\.png$/iu.test(path)) return 'image/png'
  if (/\.jpe?g$/iu.test(path)) return 'image/jpeg'
  if (/\.webp$/iu.test(path)) return 'image/webp'
  if (/\.gif$/iu.test(path)) return 'image/gif'
  return undefined
}

/** Index of the word boundary at or before `cursor` (readline alt+b). */
function wordBoundaryLeft(text: string, cursor: number): number {
  let index = cursor
  while (index > 0 && /\s/.test(text[index - 1]!)) index--
  while (index > 0 && !/\s/.test(text[index - 1]!)) index--
  return index
}

/** Index of the word boundary after `cursor` (readline alt+f). */
function wordBoundaryRight(text: string, cursor: number): number {
  const length = text.length
  let index = cursor
  while (index < length && !/\s/.test(text[index]!)) index++
  while (index < length && /\s/.test(text[index]!)) index++
  return index
}

// --- vim normal-mode helpers -----------------------------------------------
// `/vim` 编辑模式的 normal 键位几何：行/词移动与删除目标。空白分词
// （不区分 vim 的 word/WORD），对输入框场景足够且行为直观。

/** Offset of the current line's first character. */
function vimLineStart(text: string, cursor: number): number {
  return text.lastIndexOf('\n', cursor - 1) + 1
}

/** Offset of the current line's last character (exclusive, no '\n'). */
function vimLineEnd(text: string, cursor: number): number {
  const next = text.indexOf('\n', cursor)
  return next === -1 ? text.length : next
}

/** Offset of the line's first non-whitespace character (`^`). */
function vimLineFirstNonBlank(text: string, cursor: number): number {
  const start = vimLineStart(text, cursor)
  const end = vimLineEnd(text, cursor)
  let i = start
  while (i < end && /\s/.test(text[i]!)) i++
  return i
}

/** Next word start (`w`): skip the rest of the current word, then leading
 *  whitespace. Whitespace-delimited, vim-style. */
function vimWordForward(text: string, cursor: number): number {
  const len = text.length
  let i = cursor
  if (i < len && !/\s/.test(text[i]!)) {
    while (i < len && !/\s/.test(text[i]!)) i++
  }
  while (i < len && /\s/.test(text[i]!)) i++
  return i
}

/** Previous word start (`b`): from inside a word, its own start; from
 *  whitespace, the preceding word's start. */
function vimWordBackward(text: string, cursor: number): number {
  let i = cursor
  while (i > 0 && /\s/.test(text[i - 1]!)) i--
  while (i > 0 && !/\s/.test(text[i - 1]!)) i--
  return i
}

/** End of the current word (`dw`): the whitespace boundary after `cursor`. */
function vimWordEnd(text: string, cursor: number): number {
  const len = text.length
  let i = cursor
  while (i < len && !/\s/.test(text[i]!)) i++
  return i
}

// --- grapheme-cluster geometry ---------------------------------------------
// The caret, editing keys, and wrapping MUST agree on one text unit. Mixing
// UTF-16 code units (arrows/backspace), code points (wrap), and display
// cells (stringWidth) lets the caret land inside a surrogate pair or a ZWJ
// emoji — the inverted caret then shows half a glyph, Backspace deletes
// half a character, and `line.slice()` splits clusters. All offsets below
// are UTF-16 indices snapped to grapheme boundaries via the shared
// Intl.Segmenter (utils/intl.ts).

/** Ascending grapheme boundary offsets of `text` (starts at 0, ends at
 *  `text.length`). Empty text yields `[0]`. */
function graphemeBoundaries(text: string): number[] {
  const bounds = [0]
  for (const { index, segment } of getGraphemeSegmenter().segment(text)) {
    const end = index + segment.length
    if (end > bounds[bounds.length - 1]!) bounds.push(end)
  }
  return bounds
}

/** Largest grapheme boundary `<= offset` (clamped into the text). Snaps a
 *  cursor that landed mid-cluster back onto a boundary. */
function boundaryAtOrBefore(bounds: number[], offset: number): number {
  let lo = 0
  let hi = bounds.length - 1
  let ans = bounds[0]!
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (bounds[mid]! <= offset) {
      ans = bounds[mid]!
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/** Largest grapheme boundary strictly before `offset` (0 when none). */
function previousGraphemeBoundary(bounds: number[], offset: number): number {
  let lo = 0
  let hi = bounds.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (bounds[mid]! < offset) {
      ans = bounds[mid]!
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/** Smallest grapheme boundary strictly after `offset` (text.length when
 *  none). Returns `offset` unchanged when it already is the last boundary. */
function nextGraphemeBoundary(bounds: number[], offset: number): number {
  let lo = 0
  let hi = bounds.length - 1
  let ans = bounds[hi] ?? 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (bounds[mid]! > offset) {
      ans = bounds[mid]!
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return ans
}

/** Snap an arbitrary UTF-16 offset onto a grapheme boundary of `text`,
 *  clamping into range. The safety net under every cursor write. */
function normalizeCursorOffset(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length))
  return boundaryAtOrBefore(graphemeBoundaries(text), clamped)
}

/**
 * The empty input deliberately shows NO placeholder text: terminal emulators
 * paint the IME preedit (pinyin) at the physical cursor, which the app parks
 * on the caret's cell, and the app receives no input events while a
 * composition is active (Windows Terminal suppresses key events during TSF
 * composition) — so it can never hide a placeholder in time. Keeping the row
 * blank while empty is what guarantees the preedit has nothing to overlay.
 */

/** Max input rows before the visible viewport starts scrolling (CC's
 *  maxVisibleLines behavior — the box keeps a stable height). */
const MAX_VISIBLE_LINES = 5

/**
 * Fixed chrome rows around the expanded editor's text area: round border
 * (top+bottom), the title row, the status row, and the button row. The
 * editor viewport gets `terminalRows - this` rows.
 */
const EDITOR_CHROME_ROWS = 5

/**
 * Double-click self-detection window: two clicks within this many ms and
 * one cell (in either axis) of each other count as a double-click and
 * select the word under the pointer. The drag protocol resets the ink
 * multi-click chain on every press inside a drag target (the value box
 * carries onDragStart), so the prompt detects the double-click itself.
 */
const DOUBLE_CLICK_MS = 500

/**
 * Imperative handle for the Chat-level Ctrl+C rule: Chat's useInput listener
 * runs BEFORE this component's (EventEmitter registration order), so Chat
 * asks the prompt whether it holds text (→ clear it) or not (→ arm the
 * double-press exit). Populated every render; null while unmounted.
 */
export interface PromptController {
  hasText(): boolean
  clear(): void
  /**
   * Append `text` at the end of the input (external injection channel; see
   * dsh-adapter/inject-channel.ts). Unlike `fillText`, which replaces the
   * whole value, this accumulates — matching OpenCode's `tui.prompt.append`
   * so repeated editor sends build one prompt. Returns the resulting value.
   */
  append(text: string): string
  /**
   * Copy the active mouse selection to the system clipboard (OSC 52 + the
   * native fallback) and KEEP the selection for further editing. Returns
   * true when a selection existed and consumed the key; Chat's Ctrl+C
   * branch calls this first, before its clear/exit semantics.
   */
  consumeSelectionCopy(): boolean
  /** Toggle vim editing mode (`/vim`); returns the new state (true = on). */
  toggleVim(): boolean
  /** True while vim mode is on (either submode). Esc belongs to vim then —
   *  Chat's working-turn Esc interrupt must yield in BOTH submodes. */
  vimActive(): boolean}

export interface PromptInputProps {
  channel: Channel
  /** Whether the `?` help menu is open (state lives in the Chat screen). */
  helpOpen: boolean
  onToggleHelp(): void
  /**
   * Execute a slash command (built-in or plugin-registered) with its raw
   * argument text; returns false when the input should be sent to the model.
   */
  onRunCommand(name: string, rawInput: string): boolean
  /** Message-selection mode (Shift+↑): the input ignores keys while active. */
  selectionActive: boolean
  /**
   * External fill from the ctrl+r history dialog: when this prop changes to
   * a non-null string, the input replaces its value and moves the caret to
   * the end. The caller clears it via onFillConsumed once consumed.
   */
  fillText?: string | null
  onFillConsumed?(): void
  /** Double-tap Esc with an empty input: open the rewind picker (CC rewind). */
  onRewindRequest?(): void
  /**
   * CC agent-view parity: ← on an EMPTY prompt backgrounds this session and
   * opens the agent view (with text, ← moves the caret as usual).
   */
  onBackgroundRequest?(): void
  /**
   * Background sessions waiting on the user (agent view "needs input" rows
   * excluding this session); the prompt footer shows the CC-style
   * "← N agents" hint when provided (hidden when undefined).
   */
  backgroundAgentsNeedingInput?: number
  /** Filled with the live controller each render (see PromptController). */
  controllerRef?: React.RefObject<PromptController | null>
}

/**
 * Claude Code style prompt input: rounded border box (top+bottom borders
 * only), `❯ ` prompt char (dimmed while a turn is working), the text with a
 * block cursor at the cursor position, and above it the slash-command /
 * file-completion suggestion card (SuggestionCard: rounded panel with the
 * selected row behind a `❯` pointer in the theme's `suggestion` color,
 * mirroring Claude Code's PromptInputFooterSuggestions layout).
 *
 * Empty input: a solid block caret on a blank cell and nothing else — no
 * placeholder text, so the terminal-painted IME preedit (pinyin) at the
 * parked cursor can never be overlaid on anything.
 *
 * Multi-line: Shift+Enter inserts a newline; ↑/↓ move between lines while
 * the input spans multiple lines (history/command selection otherwise); the
 * visible window scrolls to keep the caret row on screen past
 * MAX_VISIBLE_LINES. Enter submits, backspace/delete edit, ←/→ move the
 * cursor, Tab completes the selected command, Ctrl+G opens the draft in the
 * external editor ($VISUAL/$EDITOR), Escape clears (or closes the help
 * menu), `?` toggles the help menu. Windows ConPTY pipelines deliver
 * whole lines with the Enter key lost: a trailing CR/LF in the input marks
 * a complete line to submit.
 *
 * Enter submits immediately even while the model is streaming — as a STEER
 * (Codex/pi semantics): the message is injected at the next step boundary
 * of the running turn and the agent continues without aborting; Tab instead
 * queues the message for after the turn (followup). Both appear in a
 * pending preview above the input until delivered. Alt+Up pulls the last
 * pending message back for editing; Esc (with pending messages while
 * working) interrupts the turn and delivers them right away; Ctrl+Enter
 * aborts the turn and sends the current input immediately.
 */
export function PromptInput({
  channel,
  helpOpen,
  onToggleHelp,
  onRunCommand,
  selectionActive,
  fillText,
  onFillConsumed,
  onRewindRequest,
  onBackgroundRequest,
  backgroundAgentsNeedingInput,
  controllerRef,
}: PromptInputProps) {
  const [themeName] = useTheme()
  // Raw stdout writer for OSC 52 clipboard writes (selection copy) — must
  // bypass the frame pipeline; null outside a mounted Ink App.
  const writeRaw = React.useContext(TerminalWriteContext)
  const [value, setValue] = React.useState('')
  const [cursor, setCursor] = React.useState(0)
  /**
   * Mouse text selection: UTF-16 offsets [start, end) in `value`, snapped
   * to grapheme boundaries, start ≤ end. Null = no selection. Created by
   * drag, Shift+click extension and double-click word select; consumed by
   * Backspace/Delete/typing; Esc clears it without touching the text.
   * With a fold block the range always stays inside the head or the tail
   * (it never crosses the chip row — clamped on every write).
   */
  const [selection, setSelection] = React.useState<{ start: number; end: number } | null>(null)
  const selectionRef = React.useRef<{ start: number; end: number } | null>(null)
  /** Anchor offset of the in-flight drag gesture (set by dragstart). */
  const dragAnchorRef = React.useRef<number | null>(null)
  /** Double-click self-detection: last click's timestamp/screen cell. */
  const lastClickAtRef = React.useRef(0)
  const lastClickColRef = React.useRef(-1)
  const lastClickRowRef = React.useRef(-1)
  /**
   * vim editing mode (`/vim` toggle): when on, Esc switches the prompt to
   * its NORMAL submode where bare keys are vim keys instead of text, and
   * i/a/o (…) return to INSERT. Enabled in insert mode so the transition
   * is seamless; the mode is session-scoped (not persisted).
   */
  const [vimEnabled, setVimEnabled] = React.useState(false)
  /** Insert submode (false = vim NORMAL). */
  const [vimInsert, setVimInsert] = React.useState(true)
  const vimEnabledRef = React.useRef(false)
  const vimInsertRef = React.useRef(true)
  vimEnabledRef.current = vimEnabled
  vimInsertRef.current = vimInsert
  /** Undo stack: vim editing ops push {value, cursor}; `u` pops. */
  const vimUndoRef = React.useRef<Array<{ value: string; cursor: number }>>([])
  /** Pending vim operator: `d` pressed, awaiting its second key. */
  const vimPendingRef = React.useRef<'' | 'd'>('')
  /**
   * CC-style fold block: the [start, end) span of `value` that renders as
   * a one-line chip while the text around it stays fully editable. Created
   * by a big paste; only an EXPLICIT expand (chip/card click, Esc) or
   * delete removes it — typing NEVER unfolds the block.
   */
  const [foldBlock, setFoldBlock] = React.useState<{ start: number; end: number } | null>(null)
  /** Synchronous mirror used by batched keys, controller clear, and mouse drag. */
  const foldBlockRef = React.useRef<{ start: number; end: number } | null>(null)
  /**
   * Fullscreen draft editor (`expandEditor`, default Ctrl+Shift+E, or the
   * ⛶ affordance at the end of the input row). While expanded the SAME
   * editing state renders into the PromptEditorLayer cover (published via
   * setPromptEditorNode each render): Enter inserts a newline, Ctrl+Enter
   * submits, Esc collapses. The fold chip is bypassed (full text shown).
   */
  const [expanded, setExpanded] = React.useState(false)
  const expandedRef = React.useRef(false)
  /** First visible row of the expanded viewport (merged with caret-follow
   *  during render; wheel events advance it and tick a re-render). */
  const expandedScrollRef = React.useRef(0)
  /**
   * Free-scroll latch: wheel browsing parks the viewport anywhere; the
   * caret-follow merge skips while it is set, and the next real caret move
   * (typing, arrows, click) re-engages following (GUI-editor semantics).
   */
  const editorFreeScrollRef = React.useRef(false)
  const prevCaretLineRef = React.useRef(-1)
  const [, setExpandedTick] = React.useState(0)
  const prevExpandedRef = React.useRef(false)
  /**
   * Feature gate (settings `dsh-tui.expandEditor`, on by default; a mock
   * channel without the field also reads as on). Off hides the ⛶
   * affordance and refuses the shortcut — the editor cannot open.
   */
  const expandEnabled = channel.expandEditor !== false
  /** Latest expanded viewport metrics for the useInput wheel branch. */
  const editorViewportRef = React.useRef<{ maxRows: number; total: number } | null>(null)
  /** Hover state of the ⤢/⛶ expand affordance in the input row. */
  const [expandHovered, setExpandHovered] = React.useState(false)
  /** Pointer over the input box (drives the hover peek card). */
  const [hovered, setHovered] = React.useState(false)
  /** 120ms grace so the pointer crossing the input border row from the
   *  chip up onto the peek card never flickers the card. */
  const hoverLeaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverEnter = React.useCallback(() => {
    if (hoverLeaveTimerRef.current) {
      clearTimeout(hoverLeaveTimerRef.current)
      hoverLeaveTimerRef.current = null
    }
    setHovered(true)
  }, [])
  const hoverLeave = React.useCallback(() => {
    if (hoverLeaveTimerRef.current) clearTimeout(hoverLeaveTimerRef.current)
    hoverLeaveTimerRef.current = setTimeout(() => setHovered(false), 120)
  }, [])
  const valueRef = React.useRef(value)
  const cursorRef = React.useRef(cursor)
  valueRef.current = value
  cursorRef.current = cursor
  // Publish the live controller (fresh closure over `value` every render).
  // clear() mirrors the double-tap-Esc clear: text + caret reset.
  React.useEffect(() => {
    if (!controllerRef) return
    controllerRef.current = {
      hasText: () => value.length > 0,
      clear: () => {
        valueRef.current = ''
        cursorRef.current = 0
        selectionRef.current = null
        foldBlockRef.current = null
        dragAnchorRef.current = null
        lastClickAtRef.current = 0
        lastClickColRef.current = -1
        lastClickRowRef.current = -1
        // Chat's idle Ctrl+C clear also withdraws the fullscreen editor —
        // the draft it was editing is gone, the cover must not linger.
        expandedRef.current = false
        setSelection(null)
        setFoldBlock(null)
        setExpanded(false)
        setValue('')
        setCursor(0)
      },
      append: (text: string) => {
        const next = valueRef.current + text
        valueRef.current = next
        cursorRef.current = next.length
        setValue(next)
        setCursor(next.length)
        return next
      },
      consumeSelectionCopy: () => {
        const sel = selectionRef.current
        if (!sel) return false
        const text = valueRef.current.slice(sel.start, sel.end)
        void setClipboard(text).then(raw => {
          if (raw) writeRaw?.(raw)
        })
        // The selection stays: copy never clears it (Esc/typing/delete do).
        return true
      },
      toggleVim: () => {
        const next = !vimEnabledRef.current
        vimEnabledRef.current = next
        setVimEnabled(next)
        // Every toggle lands in INSERT: a fresh vim user keeps typing
        // normally until they press Esc for the first time. Turning the
        // mode off also clears the undo stack — a later re-enable must
        // never `u` its way back past edits made while vim was off.
        vimInsertRef.current = true
        setVimInsert(true)
        vimPendingRef.current = ''
        vimUndoRef.current = []
        return next
      },
      vimActive: () => vimEnabledRef.current,    }
    return () => {
      controllerRef.current = null
    }
  })
  const [selectedCommand, setSelectedCommand] = React.useState(0)
  const history = React.useRef<string[]>([])
  const historyIndex = React.useRef(-1)
  const historyDraft = React.useRef('')
  // ctrl+r history fill: replace the input when a new fill arrives, then
  // tell the caller to clear it.
  const lastFill = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (fillText && fillText !== lastFill.current) {
      lastFill.current = fillText
      updateFoldBlock(null)
      setInput(fillText)
      onFillConsumed?.()
    }
  }, [fillText, onFillConsumed])
  // Double-tap Esc to clear (CC semantics).
  const escPendingRef = React.useRef(false)
  const escTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  /** True while a clipboard paste read is in flight (ignore repeat keys). */
  const clipboardBusyRef = React.useRef(false)
  /** True while the external editor owns the terminal (editor-key round-trip). */
  const editorBusyRef = React.useRef(false)
  /** Enter dedupe window: cmd pipelines can deliver one Enter as `\r`+`\n`. */
  const lastEnterAtRef = React.useRef(0)
  React.useEffect(() => {
    return () => {
      if (escTimerRef.current) clearTimeout(escTimerRef.current)
      if (hoverLeaveTimerRef.current) clearTimeout(hoverLeaveTimerRef.current)
    }
  }, [])
  const { columns, rows: terminalRows } = useTerminalSize()
  React.useEffect(() => {
    // PromptInput self-detects double-clicks because its drag target resets
    // App's global chain. Geometry changed across resize, so the same screen
    // cell no longer identifies the same grapheme.
    lastClickAtRef.current = 0
    lastClickColRef.current = -1
    lastClickRowRef.current = -1
  }, [columns, terminalRows])
  const helpScrollRef = React.useRef<ScrollBoxHandle | null>(null)
  // Help viewport budget: the overlay anchors at the composer's top edge
  // (OverlayAbove bottom:'100%') and grows UP, so its budget is the space
  // ABOVE that anchor — smallest on an empty session, where the whale
  // splash (~15 rows) sits between the screen top and the composer
  // (terminalRows minus chrome only applies once the transcript fills the
  // viewport). Take the conservative intersection: 15 rows of viewport (16
  // with the hint + margin) fits the empty-session anchor on the default
  // layout at any terminal size, and the renderer's bottom-anchored
  // clipping for absolute overlays (no negative-y clamp) then never has
  // to eat the overlay's FIRST rows — the shortcut-column headers. The
  // command registry scrolls inside the viewport, so a taller terminal
  // loses nothing functional. (PR #446; restored after the picker
  // snapshot's cherry-pick resurrected the old formula.)
  const helpViewportHeight = Math.max(3, Math.min(terminalRows - 7, 15))

  const suggestions = value.startsWith('/') ? channel.commandCompletions(value) : []
  const overlayOpen =
    suggestions.length > 0 &&
    !expanded &&
    !helpOpen &&
    !selectionActive &&
    !value.includes('\n')

  // `@` file completion (issue #15): the trigger is the mention token at the
  // CARET, so `@` works mid-message (`看看 @src/a.ts 这个`), not only when it
  // is the input's first character. The cwd listing loads when the trigger
  // appears.
  const [fileMatches, setFileMatches] = React.useState<readonly FileCandidate[]>([])
  const [fileSelected, setFileSelected] = React.useState(0)
  const mention = mentionAtCaret(value, cursor)
  const atTrigger = mention !== undefined
  const fileRequestId = React.useRef(0)
  const selectedFile = fileMatches[fileSelected]
  React.useEffect(() => {
    const requestId = ++fileRequestId.current
    if (!mention) {
      setFileMatches([])
      setFileSelected(0)
      return
    }
    const previous = selectedFile
    // Deps key on `mention.query` (and trigger on/off) only: cursor movement
    // within the same token must NOT refetch, and `selectedFile`/`fileSelected`
    // are read as their render-time values only to seed selection preservation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    void channel.listFileCandidates(mention.query, { topK: 50 }).then(next => {
      if (requestId !== fileRequestId.current) return
      setFileMatches(next)
      setFileSelected(preserveSelection(previous, next, fileSelected))
    })
  }, [channel, mention?.query, atTrigger])
  // Esc dismisses the overlay for the token being edited (it reopens once the
  // text changes); it must NOT clear a mid-message input.
  const fileEscRef = React.useRef(-1)
  React.useEffect(() => {
    fileEscRef.current = -1
  }, [value])
  const fileOverlayOpen =
    fileMatches.length > 0 &&
    !expanded &&
    !helpOpen &&
    !selectionActive &&
    fileEscRef.current !== mention?.start

  /** Fold-block state + a synchronous mirror (setInput reads the ref).
   *  Creating a block also drags a caret that sits inside it out to the
   *  block's end (the block is atomic; typing continues after it). */
  const updateFoldBlock = (block: { start: number; end: number } | null) => {
    foldBlockRef.current = block
    setFoldBlock(block)
    if (block) {
      const c = cursorRef.current
      if (c > block.start && c < block.end) {
        cursorRef.current = block.end
        setCursor(block.end)
      }
    }
  }

  const setInput = (next: string, cursorOffset = next.length) => {
    // Apply the same ingress normalization to fills/history/editor results as
    // to paste. Map the requested caret through the sanitized prefix so an
    // ANSI sequence removed before it cannot leave the caret past the text.
    const sanitizedCursor = sanitizeEditableText(next.slice(0, cursorOffset)).length
    next = sanitizeEditableText(next)
    cursorOffset = sanitizedCursor
    const prev = valueRef.current
    const prevCursor = cursorRef.current
    const block = foldBlockRef.current
    // Normalize onto a grapheme boundary (also clamps into range): every
    // caller passes a caret they believe is on a character edge — paste
    // merges, history fills, and IME composition can still hand back an
    // offset inside a surrogate pair or combining cluster.
    let offset = normalizeCursorOffset(next, cursorOffset)
    if (block) {
      // Fold block is atomic: the caret never lands INSIDE [start, end).
      if (offset > block.start && offset < block.end) {
        offset = offset - block.start < block.end - offset ? block.start : block.end
      }
      // Every real edit happens AT the caret, so a block that starts at or
      // after the caret shifts with the value delta; one fully past the
      // caret is untouched. Whole-value replacements (fill/history/editor)
      // clear the block explicitly at their call sites.
      const delta = next.length - prev.length
      let start = block.start
      let end = block.end
      if (prevCursor <= block.start) {
        start += delta
        end += delta
      }
      start = Math.max(0, Math.min(start, next.length))
      end = Math.max(start, Math.min(end, next.length))
      if (start >= end) updateFoldBlock(null)
      else if (start !== block.start || end !== block.end) updateFoldBlock({ start, end })
    }
    // The synchronous mirrors are what batch-dispatched events (one stdin
    // read → several keys, no render in between) read on their next turn.
    valueRef.current = next
    cursorRef.current = offset
    // Every real edit drops the selection: its offsets describe the OLD
    // text. Selection-consuming callers (delete/replace) read it first.
    selectionRef.current = null
    setSelection(null)
    setValue(next)
    setCursor(offset)
  }

  /**
   * Write the selection [start, end) (snapped to grapheme boundaries,
   * start ≤ end); a degenerate range clears it. With a fold block the
   * range is clamped into the side that holds `start` — the block is
   * atomic and a selection may never cross the chip row.
   */
  const updateSelection = (start: number, end: number) => {
    const text = valueRef.current
    const anchor = normalizeCursorOffset(text, start)
    let lo = normalizeCursorOffset(text, Math.min(start, end))
    let hi = normalizeCursorOffset(text, Math.max(start, end))
    const block = foldBlockRef.current
    if (block) {
      // Clamp by the ORIGINAL anchor side, not sorted `lo`: for a reverse
      // tail→head drag, `lo` is in the head even though the gesture belongs
      // to the tail. Both selection and caret must stay on the anchor side.
      if (anchor <= block.start) {
        hi = Math.min(hi, block.start)
      } else {
        lo = Math.max(lo, block.end)
        hi = Math.max(hi, block.end)
      }
    }
    if (lo >= hi) {
      selectionRef.current = null
      setSelection(null)
    } else {
      selectionRef.current = { start: lo, end: hi }
      setSelection({ start: lo, end: hi })
    }
  }

  /** Drop the selection without touching text or caret. */
  const clearSelection = () => {
    selectionRef.current = null
    setSelection(null)
  }

  /**
   * Accept the selected file suggestion: replace ONLY the mention token at
   * the caret (prefix/suffix text survives), quoting whitespace paths. A
   * directory inserts `@dir/` without a trailing space so completion
   * continues into it; a file completes the token with a space. A typed
   * `#L12-14` suffix is NOT part of the replacement — completion ends at
   * `pathEnd` so the line range survives acceptance (issue #359).
   */
  const acceptFile = (candidate: FileCandidate) => {
    if (!mention) return
    const file = candidate.path
    const body = /\s/.test(file) ? `@"${file}"` : `@${file}`
    // A typed `#L12-14` suffix rides along AFTER the completed body (before
    // the trailing space) — quoting a whitespace path must not detach it.
    const suffix = mention.pathEnd === undefined ? '' : value.slice(mention.pathEnd, mention.end)
    const insert = candidate.kind === 'directory' ? `${body}${suffix}` : `${body}${suffix} `
    const next = value.slice(0, mention.start) + insert + value.slice(mention.end)
    setInput(next, mention.start + insert.length)
    setFileSelected(0)
  }

  const submitText = (text: string, notice?: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    history.current.push(trimmed)
    if (history.current.length > HISTORY_LIMIT) history.current.shift()
    historyIndex.current = -1
    setInput('', 0)
    setSelectedCommand(0)
    void appendHistory(trimmed)
    channel.submit(trimmed)
    if (notice) {
      channel.notify(notice, { timeoutMs: 2500 })
    } else if (channel.working) {
      // While the model is streaming, the message joins the DSH inbox and is
      // processed after the current turn — say so, or it looks "lost".
      channel.notify(t('input-sent-after-turn'), { timeoutMs: 2500 })
    }
  }

  /**
   * Enter while the model is working = STEER (Codex/pi semantics): the
   * message is injected at the next step boundary of the RUNNING turn and
   * the agent continues without aborting — the "immediate" send.
   */
  const steerSend = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    history.current.push(trimmed)
    if (history.current.length > HISTORY_LIMIT) history.current.shift()
    historyIndex.current = -1
    setInput('', 0)
    setSelectedCommand(0)
    void appendHistory(trimmed)
    channel.steer(trimmed)
    channel.notify(t('input-interrupted-next'), { timeoutMs: 2500 })
  }

  /**
   * Tab while the model is working = plain queue (followup): the message
   * waits for the running turn to end, then is processed in order.
   */
  const queueSend = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    history.current.push(trimmed)
    if (history.current.length > HISTORY_LIMIT) history.current.shift()
    historyIndex.current = -1
    setInput('', 0)
    setSelectedCommand(0)
    void appendHistory(trimmed)
    channel.submit(trimmed)
    channel.notify(t('input-queued-after-turn'), { timeoutMs: 2500 })
  }

  /**
   * Alt+Up: pull the last pending message back into the input for editing
   * (never interrupts the running turn). Refused when the running dsh-agent
   * cannot withdraw inbox messages (released package without the inbox API).
   */
  const pullBackLast = () => {
    const item = channel.pending[channel.pending.length - 1]
    if (!item) return
    if (!channel.removePending(item.id)) {
      channel.notify(t('input-cannot-retract'), { color: 'warning', timeoutMs: 2500 })
      return
    }
    setInput(item.text)
    updateFoldBlock(null)
    setSelectedCommand(0)
    setFileSelected(0)
    channel.notify(t('input-retracted'), { timeoutMs: 2000 })
  }

  /**
   * Ctrl+Enter: abort the running turn and send the input immediately — the
   * model stops what it is doing and starts on this message right away.
   */
  const interruptSend = () => {
    const trimmed = value.trim()
    if (!trimmed) {
      channel.notify(t('input-empty'), { color: 'warning' })
      return
    }
    // Abort the running turn and deliver: previously queued pending
    // messages first (FIFO), then the current input — all processed
    // immediately once the abort settles.
    const count = channel.interruptAndDeliver([...channel.pending.map(item => item.text), value])
    if (count === 0) return
    history.current.push(trimmed)
    if (history.current.length > HISTORY_LIMIT) history.current.shift()
    historyIndex.current = -1
    setInput('', 0)
    setSelectedCommand(0)
    setFileSelected(0)
    void appendHistory(trimmed)
    channel.notify(t('input-interrupt-immediate'), { timeoutMs: 2500 })
  }

  /**
   * Execute a slash command (built-in, plugin-registered, or hidden) when
   * the input resolves to one: the name parses as the first token so
   * `/plan off` dispatches `plan` with its argument text, and the merged
   * command list (locals + registry) decides whether the line is a command
   * at all. Hidden commands are recognized even though they are intentionally
   * absent from the suggestion/help catalogs.
   */
  const tryRunCommand = (text: string): boolean => {
    if (!text.startsWith('/')) return false
    const parsed = parseCommandName(text)
    if (parsed === undefined) return false
    const known = channel.commandList.some(command => command.name === parsed.name)
      || isHiddenCommandName(parsed.name)
    if (!known) return false
    const handled = onRunCommand(parsed.name, parsed.rawInput)
    if (handled) {
      history.current.push(text.trim())
      if (history.current.length > HISTORY_LIMIT) history.current.shift()
      historyIndex.current = -1
      setInput('', 0)
      setSelectedCommand(0)
      void appendHistory(text.trim())
    }
    return handled
  }

  /**
   * The Enter main path, shared by the inline prompt, the expanded
   * editor's Ctrl+Enter, and its Send button:
   * - command menu open → run the SELECTED command (never send `/mo`);
   * - model working → STEER into the running turn (next step boundary,
   *   agent continues — the "immediate" send; Codex/pi semantics);
   * - otherwise → submit directly (or run a unique command).
   * Reads valueRef so a key batch (typing + Enter in one stdin read)
   * operates on the text the preceding keys produced.
   */
  const handleEnter = () => {
    // A single Enter can arrive as two events in cmd pipelines (`\r`
    // parsed as return + a raw `\n` line): collapse them so one keypress
    // never sends the message twice.
    const now = Date.now()
    if (now - lastEnterAtRef.current < 80) return
    lastEnterAtRef.current = now
    const value = valueRef.current
    if (overlayOpen) {
      const command = suggestions[selectedCommand]
      if (command) {
        tryRunCommand(command.commandLine)
        return
      }
    }
    // File-completion overlay open → Enter accepts the selection (same
    // contract as the command menu: the overlay owns Enter while open).
    if (fileOverlayOpen) {
      const file = fileMatches[fileSelected]
      if (file) {
        acceptFile(file)
        return
      }
    }
    if (channel.working && value.trim() !== '') {
      // CC's immediate-command semantics: /btw and /skills are exempt from
      // steering — neither command interrupts the running turn. Hidden
      // UI-only easter eggs (e.g. /deepseek) are also safe to run while
      // streaming. Every other input keeps the steer behavior so /new
      // /model etc. stay idle-only.
      const parsed = value.startsWith('/') ? parseCommandName(value) : undefined
      if (parsed !== undefined && (
        ((parsed.name === 'btw' || parsed.name === 'skills')
          && channel.commandList.some(c => c.name === parsed.name))
        || isHiddenCommandName(parsed.name)
      )) {
        if (tryRunCommand(value)) return
      }
      steerSend(value)
      return
    }
    if (!tryRunCommand(value)) submitText(value)
  }

  /** Expand/collapse the fullscreen editor (shortcut + ⛶ affordance).
   *  Expanding also DROPS any fold block: the fullscreen view shows and
   *  edits the full text, and the block's atomic-clamp semantics (caret
   *  pushed to its edges, selection clamped to one side) would contradict
   *  that — the chip's own click-to-expand already means "unfold". */
  const toggleExpand = () => {
    const next = !expandedRef.current
    expandedRef.current = next
    setExpanded(next)
    if (next) {
      expandedScrollRef.current = 0
      if (foldBlockRef.current) updateFoldBlock(null)
    }
    // Geometry changed wholesale (a fullscreen cover): the double-click
    // self-detection's screen-cell memory is void, same as on resize.
    lastClickAtRef.current = 0
    lastClickColRef.current = -1
    lastClickRowRef.current = -1
  }

  /** Withdraw the fullscreen editor, keeping text/caret/selection intact. */
  const collapseEditor = () => {
    expandedRef.current = false
    setExpanded(false)
    lastClickAtRef.current = 0
    lastClickColRef.current = -1
    lastClickRowRef.current = -1
  }

  /** The editor's explicit send (Ctrl+Enter / Send button): the Enter main
   *  path, then collapse — an empty draft just collapses. */
  const submitFromEditor = () => {
    handleEnter()
    collapseEditor()
  }

  /** Clipboard reads are asynchronous; insert against the latest render so
   * typing while PowerShell owns the clipboard never gets overwritten.
   * An active selection is replaced by the insert. Returns the resulting
   * value and the insertion offset so callers can apply the paste fold. */
  const insertClipboardAtCaret = (text: string): { next: string; at: number } => {
    text = sanitizeEditableText(text)
    const current = valueRef.current
    const sel = selectionRef.current
    const position = sel ? sel.start : cursorRef.current
    const next = sel
      ? current.slice(0, sel.start) + text + current.slice(sel.end)
      : current.slice(0, position) + text + current.slice(position)
    setInput(next, position + text.length)
    setSelectedCommand(0)
    setFileSelected(0)
    return { next, at: position }
  }

  /** Line index of the cursor; -1 when the cursor is at the very end. */
  const cursorLine = (text: string, cursorOffset: number) => {
    const before = text.slice(0, cursorOffset)
    return before.split('\n').length - 1
  }
  /** Column of the cursor within its line. */
  const cursorColumn = (text: string, cursorOffset: number) => {
    const before = text.slice(0, cursorOffset)
    const line = before.split('\n').pop() ?? ''
    return line.length
  }

  useInput((input, key, event) => {
    if (selectionActive) return
    // The editor round-trip ends by resuming stdin one microtask before the
    // outcome lands — drop any key squeezed into that gap so the prompt's
    // setValue can never overwrite fresh typing (and vice versa).
    if (editorBusyRef.current) return

    // Ctrl+Shift+E (remappable via /settings): toggle the fullscreen draft
    // editor. Matched before anything else so it works both while editing
    // and from an idle prompt; selectionActive has already returned above.
    // Refused while the feature is turned off in /settings.
    if (expandEnabled && actionMatches('expandEditor', input, key)) {
      event?.stopImmediatePropagation()
      toggleExpand()
      return
    }

    // App deliberately dispatches every parsed key from one stdin read in a
    // single React update. Read the synchronous mirrors so each event sees
    // the text/caret produced by the preceding event in that batch.
    const value = valueRef.current
    const cursor = cursorRef.current
    const selection = selectionRef.current

    // ── mouse selection (drag / Shift+click / double-click) ─────────────
    // Layered ahead of the fold-block rules: with an active selection, Esc
    // ONLY drops the highlight (text untouched), and Backspace/Delete
    // delete the selected span. Arrows/typing handle the selection at their
    // own arms below.
    if (key.escape && selection && !helpOpen && !overlayOpen && !fileOverlayOpen) {
      event.stopImmediatePropagation()
      clearSelection()
      return
    }
    if ((key.backspace || key.delete) && selection) {
      const next = value.slice(0, selection.start) + value.slice(selection.end)
      setInput(next, selection.start)
      setSelectedCommand(0)
      setFileSelected(0)
      return
    }

    // ── 全屏草稿编辑（expandEditor，默认 Ctrl+Shift+E / 输入行 ⛶）─────
    // 展开态拥有屏幕；Esc 收起（有选区时上面的 selection 分支已先行只清
    // 选区）。滚轮不经此——编辑区的 onWheel 位置路由直接驱动滚动窗口。
    if (key.escape && expandedRef.current) {
      // Collapse runs AHEAD of the fold-block/vim Esc meanings: the
      // fullscreen cover is the outermost modal layer.
      event?.stopImmediatePropagation()
      collapseEditor()
      return
    }

    // Fold block (CC-style): Esc expands it — it must NEVER clear text
    // that LOOKS like one line; Backspace at the block's tail / Delete at
    // its head deletes the WHOLE block in one key; ←/→ jump over the
    // atomic block. Typing NEVER expands it — the caret lives outside the
    // block and edits land in the visible text around it.
    const block = foldBlockRef.current
    // Line-level moves/edits (↑/↓/Home/End/Ctrl+A/E/U/K/W) treat the
    // block as an atomic row: boundaries that would land inside it are
    // clamped to its edges.
    const clampRowStart = (pos: number) =>
      block && cursor >= block.end ? Math.max(pos, block.end) : pos
    const clampRowEnd = (pos: number) =>
      block && cursor <= block.start ? Math.min(pos, block.start) : pos
    if (block) {
      if (key.escape) {
        updateFoldBlock(null)
        return
      }
      if ((key.backspace && cursor === block.end) || (key.delete && cursor === block.start)) {
        const next = value.slice(0, block.start) + value.slice(block.end)
        updateFoldBlock(null)
        setInput(next, block.start)
        setSelectedCommand(0)
        setFileSelected(0)
        return
      }
      if (key.leftArrow && cursor === block.end) {
        setInput(value, block.start)
        return
      }
      if (key.rightArrow && cursor === block.start) {
        setInput(value, block.end)
        return
      }
    }

    // Grapheme boundaries of the current text: every caret move / delete
    // below snaps onto one of these offsets (never mid-cluster).
    const bounds = graphemeBoundaries(value)

    /** Insert text at the caret (typing, paste) and dismiss overlays. An
     *  active selection is REPLACED by the insert (standard editor
     *  semantics). Returns the insertion offset so callers can derive the
     *  inserted span (paste fold). */
    const insertAtCaret = (text: string): number => {
      if (helpOpen) onToggleHelp()
      const sel = selectionRef.current
      const at = sel ? sel.start : cursor
      const next = sel
        ? value.slice(0, sel.start) + text + value.slice(sel.end)
        : value.slice(0, cursor) + text + value.slice(cursor)
      setInput(next, at + text.length)
      setSelectedCommand(0)
      setFileSelected(0)
      return at
    }

    // Bracketed paste (terminal paste — Ctrl+Shift+V / right-click): insert
    // at the caret after removing terminal controls and expanding tabs.
    // Newlines remain data — they are NOT Enter — so this branch runs before
    // the whole-line submit rule.
    if (event?.isPasted && input.length > 0) {
      const text = sanitizeEditableText(input.replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
      const at = insertAtCaret(text)
      // A big paste becomes a CC-style fold block right away (hover peeks
      // at it); an existing block is replaced by the new paste's span.
      // The EXPANDED editor never folds — pasting there is plain text
      // (fold semantics would clamp the caret out of the pasted span).
      if (!expandedRef.current && isBigInput(text)) updateFoldBlock({ start: at, end: at + text.length })
      return
    }

    // Clipboard paste (default Ctrl+V / Cmd+V, plus the Alt+V alias for
    // terminals that intercept Ctrl+V — combos are user-remappable via
    // /settings): raw mode hands the key to the app, so the clipboard is
    // read here — text, file paths when the file manager copied files, or
    // an exported temp-file path when the clipboard holds a raw image.
    if (actionMatches('paste', input, key)) {
      if (clipboardBusyRef.current) return
      // Match insertAtCaret's overlay/selection dismissal up front: the
      // async continuation below only sets value/cursor, so a paste landing
      // while the help overlay is open would otherwise insert behind it.
      if (helpOpen) onToggleHelp()
      setSelectedCommand(0)
      setFileSelected(0)
      clipboardBusyRef.current = true
      void readClipboard()
        .then(async content => {
          if (content === null) {
            channel.notify(t('input-clipboard-empty'), { color: 'warning' })
            return
          }
          if (content.kind === 'unavailable') {
            channel.notify(t('input-clipboard-unavailable'), { color: 'warning' })
            return
          }
          if (content.kind === 'image') {
            const mediaType = clipboardImageMediaType(content.path)
            if (mediaType !== undefined) {
              try {
                const token = await channel.stageImage({
                  data: new Uint8Array(await readFile(content.path)),
                  mediaType,
                  name: basename(content.path),
                })
                await unlink(content.path).catch(() => undefined)
                insertClipboardAtCaret(`${token} `)
                channel.notify(t('input-image-pasted', { token }), { timeoutMs: 2500 })
                return
              } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error)
                channel.notify(t('input-image-paste-failed', { err: message }), { color: 'warning', timeoutMs: 5000 })
              }
            }
          }
          // Insert against the LIVE input state: the read above resolved
          // asynchronously and the user may have typed while waiting.
          const text = sanitizeEditableText(formatClipboardInsert(content))
          const { at } = insertClipboardAtCaret(text)
          // Same fold as bracketed paste — but never inside the expanded
          // editor (plain text there, see the isPasted branch).
          if (!expandedRef.current && isBigInput(text)) updateFoldBlock({ start: at, end: at + text.length })
        })
        .catch(() => {
          channel.notify(t('input-clipboard-read-failed'), { color: 'warning' })
        })
        .finally(() => {
          // A rejected read must never wedge Ctrl+V for the rest of the
          // session.
          clipboardBusyRef.current = false
        })
      return
    }

    // Help is modal for modified keys and every Enter variant. The paste
    // branch above is the intentional exception: paste closes Help and
    // inserts visibly.
    // Swallow here before editor/submit/interrupt branches can mutate hidden
    // composer or working-turn state; plain typing still dismisses Help below.
    if (helpOpen && !key.escape && (key.ctrl || key.meta || key.super || key.return || input.includes('\n') || input.includes('\r'))) {
      event.stopImmediatePropagation()
      return
    }

    // Ctrl+G (remappable via /settings): edit the current draft in
    // $VISUAL/$EDITOR (issue #123, readline's edit-and-execute-command). The
    // draft is written to a temp file, the terminal is handed to the editor
    // (Ink's alt-screen handoff), and the saved text replaces the input when
    // it differs. The util maps every failure to an outcome, but the
    // catch/finally here is the hard guarantee: a rejected promise must
    // never kill the process, and the busy flag must always clear or the
    // editor key stays locked forever.
    if (actionMatches('editor', input, key)) {
      editorBusyRef.current = true
      void (async () => {
        try {
          const outcome = await editInExternalEditor(value)
          if (outcome.kind === 'edited') {
            updateFoldBlock(null)
            setInput(outcome.text)
            setSelectedCommand(0)
            setFileSelected(0)
          } else if (outcome.kind === 'unavailable') {
            channel.notify(t('input-editor-unavailable'), { color: 'warning' })
          } else if (outcome.kind === 'failed') {
            channel.notify(t('input-editor-failed', { name: outcome.message }), {
              color: 'warning',
            })
          }
        } catch {
          channel.notify(t('input-editor-failed', { name: 'unknown' }), {
            color: 'warning',
          })
        } finally {
          editorBusyRef.current = false
        }
      })()
      return
    }

    // Ctrl+J is the portable multiline fallback when a terminal cannot
    // report modifiers on Enter. Legacy terminals deliver bare LF (`enter`),
    // while kitty/modifyOtherKeys encode it as an exact Ctrl+J key.
    const isCtrlJ = input === 'j' && key.ctrl && !key.shift && !key.meta && !key.super
    if ((input === '\n' && event?.keypress.name === 'enter') || isCtrlJ) {
      insertAtCaret('\n')
      return
    }

    // Whole-line input from Windows ConPTY pipelines (cmd batch -> node):
    // the trailing CR/LF marks a complete line to submit. A bare CR/CRLF is
    // Enter, while real multi-char piped lines keep the legacy direct-submit
    // path. The expanded editor treats piped lines as DATA — CR/LF
    // normalizes to '\n' and inserts (sending needs Ctrl+Enter there), so a
    // fast batch never dumps raw '\r' into the draft.
    if (input.includes('\n') || input.includes('\r')) {
      if (expandedRef.current) {
        insertAtCaret(
          sanitizeEditableText(input.replace(/\r\n/g, '\n').replace(/\r/g, '\n')),
        )
        return
      }
      if (/^[\r\n]+$/.test(input)) {
        handleEnter()
        return
      }
      const line = (value + input).trim()
      if (line.startsWith('/')) {
        const matches = channel.commandCompletions(line)
        if (matches.length === 1) {
          tryRunCommand(matches[0]!.commandLine)
          return
        }
      }
      if (!tryRunCommand(line)) submitText(line)
      return
    }
    if (key.return && isMod(key)) {
      // Ctrl+Enter / Cmd+Enter: in the EXPANDED editor this is the explicit
      // send (Enter inserts newlines there, so sending needs its own key);
      // inline it interrupts the running turn and processes this message
      // immediately (Windows Terminal sends CSI 13;5u / 13;1;5u).
      if (expandedRef.current) {
        submitFromEditor()
      } else {
        interruptSend()
      }
      return
    }
    if (key.return && (key.shift || key.meta)) {
      // Shift+Enter / Option+Enter: insert a newline at the caret
      // (multi-line input). Shift+Enter only arrives when the terminal
      // supports extended key reporting (kitty/modifyOtherKeys allowlist in
      // ink/terminal.ts); Option+Enter (ESC CR) is the fallback on terminals
      // that can't report shift — e.g. macOS Terminal.app (issue #110).
      insertAtCaret('\n')
      return
    }
    if (key.return && expandedRef.current) {
      // Expanded editor: plain Enter inserts a newline (text-editor
      // semantics — long-draft editing must never misfire a send). The
      // shift/meta variants above already newline; Ctrl+Enter sends.
      insertAtCaret('\n')
      return
    }
    if (key.return) {
      handleEnter()
      return
    }
    // Help is modal over the composer. Backtab must not cycle the session
    // mode invisibly behind it, and plain Tab has no Help action.
    if (helpOpen && key.tab) {
      event.stopImmediatePropagation()
      return
    }
    // Expanded editor: Tab is indentation, Shift+Tab a silent swallow —
    // neither command completion nor session-mode cycling makes sense on
    // the fullscreen editor, and both would fire invisibly behind it.
    if (expandedRef.current && key.tab) {
      if (!key.shift) insertAtCaret('    ')
      return
    }
    // Shift+Tab cycles the configured session modes (default: 默认 →
    // 计划模式 → 完全访问; each mode bundles plan/sandbox/approval atoms —
    // see the `modes` config). Must precede the plain-Tab arms — the parser
    // reports backtab as key.tab + key.shift.
    if (key.tab && key.shift) {
      void channel.cycleMode()
      return
    }
    if (key.tab && fileOverlayOpen) {
      const file = fileMatches[fileSelected]
      if (file) acceptFile(file)
      return
    }
    if (key.tab && overlayOpen) {
      const command = suggestions[selectedCommand]
      if (command) {
        updateFoldBlock(null)
        setInput(command.replacement)
      }
      return
    }
    // Tab while the model is working = queue for AFTER the turn (followup),
    // distinct from Enter's steer (Codex's "tab to queue message").
    if (key.tab && channel.working && value.trim() !== '') {
      queueSend(value)
      return
    }
    // Help is a viewport, not prompt history. It deliberately owns every
    // vertical navigation event while visible; otherwise Up/Down silently
    // walk the input history and the clipped command rows remain unreachable.
    if (helpOpen) {
      const page = Math.max(1, helpViewportHeight - 2)
      if (key.upArrow || key.wheelUp) {
        helpScrollRef.current?.scrollBy(key.wheelUp ? -3 : -1)
        event.stopImmediatePropagation()
        return
      }
      if (key.downArrow || key.wheelDown) {
        helpScrollRef.current?.scrollBy(key.wheelDown ? 3 : 1)
        event.stopImmediatePropagation()
        return
      }
      if (key.pageUp || key.pageDown) {
        helpScrollRef.current?.scrollBy(key.pageUp ? -page : page)
        event.stopImmediatePropagation()
        return
      }
      if (key.home) {
        helpScrollRef.current?.scrollTo(0)
        event.stopImmediatePropagation()
        return
      }
      if (key.end) {
        // Use a deliberately oversized absolute target rather than the
        // sticky-bottom path: compact Help may still be measuring nested
        // sections in this commit, while ScrollBox's render clamp resolves
        // the target to the exact current maximum without a follow-up frame.
        helpScrollRef.current?.scrollTo(Number.MAX_SAFE_INTEGER)
        event.stopImmediatePropagation()
        return
      }
    }
    if (key.meta && key.upArrow) {
      // Alt+Up: pull the last pending message back for editing (pi/Codex).
      pullBackLast()
      return
    }
    if (key.upArrow) {
      // A history walk owns the arrows until it returns to the draft: a
      // recalled entry can itself open the @ menu or the slash menu (e.g.
      // `/model`), and letting the overlay navigate here strands the stashed
      // draft — Down would cycle menu rows instead of walking back.
      if (fileOverlayOpen && historyIndex.current < 0) {
        setFileSelected(index =>
          index <= 0 ? fileMatches.length - 1 : index - 1,
        )
        return
      }
      // With a fold block the caret in the tail walks the TAIL's lines
      // (the block is one atomic row); the first tail line steps over the
      // block to its head.
      if (block && cursor >= block.end) {
        const tailCursor = cursor - block.end
        const line = cursorLine(tail, tailCursor)
        if (line > 0) {
          const upToLineStart = tail.lastIndexOf('\n', tailCursor - 1)
          const prevLineStart =
            upToLineStart === -1 ? 0 : tail.lastIndexOf('\n', upToLineStart - 1) + 1
          const prevLine = tail.slice(prevLineStart, upToLineStart)
          setInput(
            value,
            block.end + prevLineStart + Math.min(cursorColumn(tail, tailCursor), prevLine.length),
          )
          return
        }
        setInput(value, block.start)
        return
      }
      const line = cursorLine(value, cursor)
      if (line > 0) {
        // Move to the previous line, clamping to its length.
        const upToLineStart = value.lastIndexOf('\n', cursor - 1)
        const prevLineStart =
          upToLineStart === -1 ? 0 : value.lastIndexOf('\n', upToLineStart - 1) + 1
        const prevLine = value.slice(prevLineStart, upToLineStart)
        setInput(value, prevLineStart + Math.min(cursorColumn(value, cursor), prevLine.length))
        return
      }
      if (overlayOpen && historyIndex.current < 0) {
        setSelectedCommand(index =>
          index <= 0 ? suggestions.length - 1 : index - 1,
        )
        return
      }
      if (history.current.length === 0) return
      if (historyIndex.current < 0) {
        historyDraft.current = value
        historyIndex.current = history.current.length - 1
      } else {
        historyIndex.current = Math.max(0, historyIndex.current - 1)
      }
      const entry = history.current[historyIndex.current] ?? ''
      updateFoldBlock(null)
      setInput(entry)
      return
    }
    if (key.downArrow) {
      // Same history-walk ownership as ↑ above.
      if (fileOverlayOpen && historyIndex.current < 0) {
        setFileSelected(index =>
          index >= fileMatches.length - 1 ? 0 : index + 1,
        )
        return
      }
      // Mirror of the tail-side ↑ walk: with a fold block the caret walks
      // the TAIL's lines; past its last line it falls through to the
      // overlay/history handling below.
      if (block && cursor >= block.end) {
        const tailCursor = cursor - block.end
        const line = cursorLine(tail, tailCursor)
        const lines = tail.split('\n')
        if (line < lines.length - 1) {
          const nextLineStart = tail.indexOf('\n', tailCursor) + 1
          const nextLineEnd = tail.indexOf('\n', nextLineStart)
          const nextLine = tail.slice(
            nextLineStart,
            nextLineEnd === -1 ? tail.length : nextLineEnd,
          )
          setInput(
            value,
            block.end + nextLineStart + Math.min(cursorColumn(tail, tailCursor), nextLine.length),
          )
          return
        }
      } else if (block && cursor <= block.start) {
        // Head side: walk the HEAD's lines; its last line steps over the
        // block to the tail (never into history for a multi-row input).
        const line = cursorLine(head, cursor)
        const lines = head.split('\n')
        if (line < lines.length - 1) {
          const nextLineStart = head.indexOf('\n', cursor) + 1
          const nextLineEnd = head.indexOf('\n', nextLineStart)
          const nextLine = head.slice(
            nextLineStart,
            nextLineEnd === -1 ? head.length : nextLineEnd,
          )
          setInput(
            value,
            nextLineStart + Math.min(cursorColumn(head, cursor), nextLine.length),
          )
          return
        }
        setInput(value, block.end)
        return
      }
      const line = cursorLine(value, cursor)
      const lines = value.split('\n')
      if (line < lines.length - 1) {
        const nextLineStart = value.indexOf('\n', cursor) + 1
        const nextLineEnd = value.indexOf('\n', nextLineStart)
        const nextLine = value.slice(
          nextLineStart,
          nextLineEnd === -1 ? value.length : nextLineEnd,
        )
        setInput(value, nextLineStart + Math.min(cursorColumn(value, cursor), nextLine.length))
        return
      }
      if (overlayOpen && historyIndex.current < 0) {
        setSelectedCommand(index =>
          index >= suggestions.length - 1 ? 0 : index + 1,
        )
        return
      }
      if (historyIndex.current < 0) return
      if (historyIndex.current >= history.current.length - 1) {
        historyIndex.current = -1
        updateFoldBlock(null)
        setInput(historyDraft.current)
      } else {
        historyIndex.current += 1
        setInput(history.current[historyIndex.current] ?? '')
      }
      return
    }
    if (isMod(key) && key.leftArrow) {
      // Jump to the previous word boundary (readline alt+b). Must precede the
      // bare-arrow arms: Ctrl+Left arrives as leftArrow + ctrl. An active
      // selection collapses to its START edge first (editor semantics).
      const sel = selectionRef.current
      setInput(value, sel ? sel.start : wordBoundaryLeft(value, cursor))
      return
    }
    if (isMod(key) && key.rightArrow) {
      // Jump to the next word boundary (readline alt+f).
      const sel = selectionRef.current
      setInput(value, sel ? sel.end : wordBoundaryRight(value, cursor))
      return
    }
    if (key.leftArrow) {
      // CC agent-view parity: ← on an EMPTY prompt backgrounds this session
      // and opens the agent view; with text it moves the caret as usual.
      // (The command/file overlays both imply non-empty text, so no extra
      // gate beyond the help menu is needed.)
      if (value.length === 0 && !helpOpen) {
        onBackgroundRequest?.()
        return
      }
      // Grapheme-step: skip the whole cluster (surrogate pair, ZWJ emoji,
      // combining mark) so the caret never sits inside one. With a
      // selection, collapse to its start edge instead.
      const sel = selectionRef.current
      setInput(value, sel ? sel.start : previousGraphemeBoundary(bounds, cursor))
      return
    }
    if (key.rightArrow) {
      const sel = selectionRef.current
      setInput(value, sel ? sel.end : nextGraphemeBoundary(bounds, cursor))
      return
    }
    if (key.backspace) {
      if (cursor === 0) return
      const start = previousGraphemeBoundary(bounds, cursor)
      setInput(value.slice(0, start) + value.slice(cursor), start)
      return
    }
    if (key.delete) {
      const end = nextGraphemeBoundary(bounds, cursor)
      if (end === cursor) return
      setInput(value.slice(0, cursor) + value.slice(end), cursor)
      return
    }
    if (key.home) {
      // Start of the current line (the block is one atomic row).
      const lineStart = clampRowStart(value.lastIndexOf('\n', cursor - 1) + 1)
      setInput(value, lineStart)
      return
    }
    if (key.end) {
      // End of the current line.
      const nextLine = value.indexOf('\n', cursor)
      setInput(value, nextLine === -1 ? value.length : clampRowEnd(nextLine))
      return
    }
    if (isMod(key) && input === 'a') {
      const lineStart = clampRowStart(value.lastIndexOf('\n', cursor - 1) + 1)
      setInput(value, lineStart)
      return
    }
    if (isMod(key) && input === 'e') {
      const nextLine = value.indexOf('\n', cursor)
      setInput(value, nextLine === -1 ? value.length : clampRowEnd(nextLine))
      return
    }
    if (isMod(key) && input === 'u') {
      // Delete to start of line (never into the block).
      const lineStart = clampRowStart(value.lastIndexOf('\n', cursor - 1) + 1)
      setInput(value.slice(0, lineStart) + value.slice(cursor), lineStart)
      return
    }
    if (isMod(key) && input === 'k') {
      // Delete to end of line (never into the block).
      const nextLine = value.indexOf('\n', cursor)
      const end = nextLine === -1 ? value.length : clampRowEnd(nextLine)
      setInput(value.slice(0, cursor) + value.slice(end), cursor)
      return
    }
    if (isMod(key) && input === 'w') {
      // Delete the word before the cursor (CC/readline behavior): skip
      // trailing whitespace, then the whitespace-delimited word. The
      // deletion start never crosses into the block.
      const before = value.slice(0, cursor)
      let end = before.length
      while (end > 0 && /\s/.test(before[end - 1]!)) end--
      let start = end
      while (start > 0 && !/\s/.test(before[start - 1]!)) start--
      const clipped = clampRowStart(start)
      setInput(value.slice(0, clipped) + value.slice(cursor), clipped)
      return
    }
    // ── vim mode (`/vim`) ──────────────────────────────────────────────
    // INSERT submode: only Esc is intercepted (back to NORMAL — the usual
    // clear/rewind Esc semantics stay disabled while vim is on).
    // NORMAL submode: bare characters and Esc are vim keys; help/command/
    // file overlays, modified combos, Tab, Enter, arrows and other
    // structured keys keep their existing handlers.
    const vimNormalEdit = (next: string, cursorOffset: number) => {
      updateFoldBlock(null)
      setInput(next, cursorOffset)
      setSelectedCommand(0)
      setFileSelected(0)
    }
    const vimPushUndo = () => {
      if (vimUndoRef.current.length >= 100) vimUndoRef.current.shift()
      vimUndoRef.current.push({ value: valueRef.current, cursor: cursorRef.current })
    }
    const handleVimNormal = (input: string) => {
      // One stdin batch can merge several bare keys into a single event
      // (fast typing), so re-read the synchronous mirrors and recompute
      // the grapheme boundaries: every key in the batch operates on the
      // text/caret its predecessor produced (the outer `value`/`cursor`/
      // `bounds` reflect only the batch's first key).
      const value = valueRef.current
      const cursor = cursorRef.current
      const bounds = graphemeBoundaries(value)
      const pending = vimPendingRef.current
      vimPendingRef.current = ''
      // Operator pending (`d`): the second key picks the target.
      if (pending === 'd') {
        switch (input) {
          case 'd': { // delete the whole line, newline included (vim `dd`);
            // the last line has no newline — its content is cleared
            vimPushUndo()
            const lineStart = vimLineStart(value, cursor)
            const lineEnd = vimLineEnd(value, cursor)
            const end = lineEnd < value.length ? lineEnd + 1 : lineEnd
            vimNormalEdit(value.slice(0, lineStart) + value.slice(end), lineStart)
            return
          }
          case '$': { // delete to end of line
            vimPushUndo()
            const end = vimLineEnd(value, cursor)
            vimNormalEdit(value.slice(0, cursor) + value.slice(end), cursor)
            return
          }
          case '0':
          case '^': { // delete to start of line
            vimPushUndo()
            const start =
              input === '^' ? vimLineFirstNonBlank(value, cursor) : vimLineStart(value, cursor)
            vimNormalEdit(value.slice(0, start) + value.slice(cursor), start)
            return
          }
          case 'w': { // delete to end of word
            vimPushUndo()
            const end = vimWordEnd(value, cursor)
            vimNormalEdit(value.slice(0, cursor) + value.slice(end), cursor)
            return
          }
          default:
            return // unrecognized second key: cancel the operator, drop it
        }
      }
      switch (input) {
        case 'h':
          setInput(value, previousGraphemeBoundary(bounds, cursor))
          return
        case 'l':
          setInput(value, nextGraphemeBoundary(bounds, cursor))
          return
        case 'j': { // down one line (single-line input: no-op)
          const line = cursorLine(value, cursor)
          const lines = value.split('\n')
          if (line >= lines.length - 1) return
          const col = Math.min(cursorColumn(value, cursor), (lines[line + 1] ?? '').length)
          setInput(value, vimLineEnd(value, cursor) + 1 + col)
          return
        }
        case 'k': { // up one line
          const line = cursorLine(value, cursor)
          if (line <= 0) return
          const lines = value.split('\n')
          const col = Math.min(cursorColumn(value, cursor), (lines[line - 1] ?? '').length)
          const prevStart = vimLineStart(value, vimLineStart(value, cursor) - 1)
          setInput(value, prevStart + col)
          return
        }
        case '0': {
          setInput(value, vimLineStart(value, cursor))
          return
        }
        case '^': {
          setInput(value, vimLineFirstNonBlank(value, cursor))
          return
        }
        case '$': {
          setInput(value, vimLineEnd(value, cursor))
          return
        }
        case 'w':
          setInput(value, vimWordForward(value, cursor))
          return
        case 'b':
          setInput(value, vimWordBackward(value, cursor))
          return
        case 'x': { // delete the character at the caret; at the very end of
          // the text delete the last character (vim: the caret sits ON the
          // last char after `$`, so `x` must still delete it). Same rule
          // when the caret sits right before a '\n' mid-draft — after `$`
          // the caret is on the line's last char, `x` must delete THAT
          // char, not the newline (which would join the lines).
          if (cursor > 0 && (cursor === value.length || value[cursor] === '\n')) {
            const start = previousGraphemeBoundary(bounds, cursor)
            vimPushUndo()
            vimNormalEdit(value.slice(0, start) + value.slice(cursor), start)
            return
          }
          const end = nextGraphemeBoundary(bounds, cursor)
          if (end === cursor) return
          vimPushUndo()
          vimNormalEdit(value.slice(0, cursor) + value.slice(end), cursor)
          return
        }
        case 'X': { // delete the character before the caret
          if (cursor === 0) return
          const start = previousGraphemeBoundary(bounds, cursor)
          vimPushUndo()
          vimNormalEdit(value.slice(0, start) + value.slice(cursor), start)
          return
        }
        case 'd':
          vimPendingRef.current = 'd'
          return
        case 'u': { // undo the last vim edit
          const prev = vimUndoRef.current.pop()
          if (prev === undefined) return
          updateFoldBlock(null)
          setInput(prev.value, prev.cursor)
          setSelectedCommand(0)
          setFileSelected(0)
          return
        }
        case 'i': // insert at the caret
          vimInsertRef.current = true
          setVimInsert(true)
          return
        case 'I': { // insert at the line's first non-blank (vim `I`)
          setInput(value, vimLineFirstNonBlank(value, cursor))
          vimInsertRef.current = true
          setVimInsert(true)
          return
        }
        case 'a': { // insert after the caret
          setInput(value, nextGraphemeBoundary(bounds, cursor))
          vimInsertRef.current = true
          setVimInsert(true)
          return
        }
        case 'A': { // insert at the line end
          setInput(value, vimLineEnd(value, cursor))
          vimInsertRef.current = true
          setVimInsert(true)
          return
        }
        case 'o': { // new line below, then insert
          vimPushUndo()
          const end = vimLineEnd(value, cursor)
          vimNormalEdit(value.slice(0, end) + '\n' + value.slice(end), end + 1)
          vimInsertRef.current = true
          setVimInsert(true)
          return
        }
        case 'O': { // new line above, then insert
          vimPushUndo()
          const start = vimLineStart(value, cursor)
          vimNormalEdit(value.slice(0, start) + '\n' + value.slice(start), start)
          vimInsertRef.current = true
          setVimInsert(true)
          return
        }
        default:
          return // unrecognized key: ignored (never inserts in NORMAL)
      }
    }
    if (vimEnabledRef.current) {
      if (vimInsertRef.current) {
        // INSERT: Esc returns to NORMAL instead of the clear/rewind path.
        if (key.escape && !helpOpen && !overlayOpen && !fileOverlayOpen) {
          event.stopImmediatePropagation()
          vimInsertRef.current = false
          setVimInsert(false)
          return
        }
      } else if (!helpOpen && !overlayOpen && !fileOverlayOpen) {
        if (key.escape) {
          // NORMAL: Esc cancels a pending operator and otherwise no-ops
          // (the clear/rewind double-Esc semantics belong to non-vim mode).
          vimPendingRef.current = ''
          event.stopImmediatePropagation()
          return
        }
        const plainChar =
          input.length > 0 &&
          !key.ctrl && !key.meta && !key.super && !key.tab && !key.return
        if (plainChar) {
          // `?` on an empty input falls through to the help shortcut below.
          if (input === '?' && value.length === 0) return
          // `/` opens the slash-command menu even in NORMAL: insert it and
          // switch to INSERT so the rest of the command types normally
          // (the menu then owns the keys while it is open).
          if (input === '/') {
            const text = valueRef.current
            const pos = cursorRef.current
            const next = text.slice(0, pos) + '/' + text.slice(pos)
            setInput(next, pos + 1)
            setSelectedCommand(0)
            setFileSelected(0)
            vimInsertRef.current = true
            setVimInsert(true)
            return
          }
          event.stopImmediatePropagation()
          // A merged multi-char event (fast typing) is one vim key per
          // character — handleVimNormal re-reads the refs each call, so a
          // batch like `dd` works exactly like two separate keypresses.
          // Once a key switches back to INSERT (i/a/o/…), the remaining
          // characters of the batch are ordinary typing and insert as text.
          for (let i = 0; i < input.length; i++) {
            if (vimInsertRef.current) {
              const rest = input.slice(i)
              const text = valueRef.current
              const pos = cursorRef.current
              const next = text.slice(0, pos) + rest + text.slice(pos)
              setInput(next, pos + rest.length)
              setSelectedCommand(0)
              setFileSelected(0)
              break
            }
            handleVimNormal(input[i]!)
          }
          return
        }
      }
    }

    if (key.escape) {
      if (helpOpen) {
        onToggleHelp()
        return
      }
      // A single Esc closes the open command menu first (CC/pi behavior);
      // the double-tap-clear semantics only apply to ordinary input.
      if (overlayOpen) {
        setInput('', 0)
        setSelectedCommand(0)
        setFileSelected(0)
        return
      }
      // File overlay: Esc dismisses the menu for THIS token only — clearing
      // the input would nuke a mid-message `@` mention's surrounding text.
      if (fileOverlayOpen) {
        fileEscRef.current = mention?.start ?? -1
        return
      }
      // With pending messages while working, Esc = interrupt and deliver
      // them right away (Codex's "interrupt and send immediately"): the
      // turn is aborted and each message is re-queued once it settles.
      if (channel.working && channel.pending.length > 0) {
        const count = channel.interruptAndDeliver(channel.pending.map(item => item.text))
        channel.notify(t('interrupt-delivered', { n: count }), {
          timeoutMs: 2500,
        })
        return
      }
      // A single Esc clears the current input (if any); the double-tap
      // path below handles rewind/clear on an already-empty input. A BIG
      // input folds into a block instead (Esc = the fold toggle; the
      // expand → fold → expand cycle is lossless, and clearing a big draft
      // stays reachable via the block-delete Backspace or Ctrl+C).
      if (value.length > 0) {
        if (isBigInput(value)) {
          updateFoldBlock({ start: 0, end: value.length })
          setSelectedCommand(0)
          setFileSelected(0)
          return
        }
        setInput('', 0)
        setSelectedCommand(0)
        setFileSelected(0)
        return
      }
      // Double-tap Esc: clear the input when it has content; when empty,
      // open the rewind picker (CC's "Double-tap esc to rewind the code
      // and/or conversation to a previous point in time").
      if (escPendingRef.current) {
        escPendingRef.current = false
        if (escTimerRef.current) clearTimeout(escTimerRef.current)
        if (value.length === 0) {
          onRewindRequest?.()
        } else {
          setInput('', 0)
        }
        return
      }
      escPendingRef.current = true
      channel.notify(
        value.length === 0 ? t('esc-again-rewind') : t('esc-again-clear'),
      )
      escTimerRef.current = setTimeout(() => {
        escPendingRef.current = false
      }, 3000)
      return
    }
    if (input === '?' && value.length === 0 && !expandedRef.current) {
      onToggleHelp()
      return
    }
    if (input && !key.ctrl && !key.meta && !key.super && !key.tab && !key.escape) {
      // Typing anything else dismisses the help menu (CC behavior).
      if (helpOpen) onToggleHelp()
      // An active selection is REPLACED by the typed text, caret after it.
      const sel = selectionRef.current
      const at = sel ? sel.start : cursor
      const next = sel
        ? value.slice(0, sel.start) + input + value.slice(sel.end)
        : value.slice(0, cursor) + input + value.slice(cursor)
      setInput(next, at + input.length)
      setSelectedCommand(0)
      setFileSelected(0)
    }
  })

  // === Render: hard-wrap every logical line at the input width, then show
  // the window of visual lines with the caret row always visible (CC's
  // maxVisibleLines behavior with automatic wrapping).
  // Narrow terminals: the usable width follows the real terminal down to a
  // single column — a fixed floor of 10 would wrap far too early and park
  // the declared cursor past the value box's actual width.
  // The vim badge ('INSERT '/'NORMAL ', 7 cols) sits BEFORE the value box in
  // the same row, so the wrap budget must shrink by its width or long lines
  // would be clipped at the value box's right edge.
  const vimBadgeCols = vimEnabled ? 7 : 0
  // 补全卡片边框与输入框 idle 边框同色（plan 模式下整套面板一起变 sage
  // 绿）。`/color` 会话强调色优先于主题 promptBorder（plan 模式仍整体走
  // sage 绿）。`?? ''` 防御最小 mock channel（只声明用到的字段的回归脚
  // 本）。声明在渲染派生区之前：展开编辑器的行号高亮与边框同用此色。
  const sessionAccent = sessionColorHex(channel.sessionColor ?? '')
  const promptAccent = channel.mode.plan === true ? 'planMode' : (sessionAccent ?? 'promptBorder')
  // 展开态布局参数：编辑器独占整屏 —— 行号槽（宽度随逻辑行数伸缩）+
  // 圆角边框 2 + 两侧 padding 各 1 占列，❯ 前缀 / vim 徽标 / ⛶ 按钮
  // 全部让位；收起态额外扣掉行尾 ⛶ 按钮的 2 列。
  const editorLogicalLines = expanded ? value.split('\n').length : 1
  const editorNoWidth = Math.max(2, String(editorLogicalLines).length)
  const editorGutterCols = editorNoWidth + 3
  const inputWidth = expanded
    ? Math.max(1, columns - 4 - editorGutterCols)
    : Math.max(1, columns - 3 - vimBadgeCols - (expandEnabled ? 2 : 0))
  // 展开态无视折叠块：全屏编辑就是为了看全文（foldBlock 状态保留，
  // 收起后折叠显示恢复）。
  const block = expanded ? null : foldBlock
  // Fold-block model: the value renders as [head rows][chip row][tail rows]
  // — the block is ONE atomic visual row regardless of its text size; text
  // before/after it stays fully editable and never unfolds it.
  const foldText = block ? value.slice(block.start, block.end) : value
  const head = block ? value.slice(0, block.start) : ''
  const tail = block ? value.slice(block.end) : ''
  const headRows = block ? wrapToWidth(head, inputWidth) : []
  const tailRows = block ? wrapToWidth(tail, inputWidth) : []
  const chipRow = block ? headRows.length : -1
  const visualLines = block
    ? [...headRows, '', ...tailRows]
    : wrapToWidth(value, inputWidth)
  // Caret geometry uses the FULL wrap (not `value.slice(0, cursor)`):
  // word-wrap carry moves already-placed clusters, so a prefix wrap would
  // disagree with the displayed rows whenever the cursor sits inside a
  // carried word.
  const caretPlaced = block
    ? cursor <= block.start
      ? caretInText(head, inputWidth, cursor)
      : caretInText(tail, inputWidth, Math.max(0, cursor - block.end))
    : caretInText(value, inputWidth, cursor)
  const caretVisualLine =
    block && cursor > block.start
      ? headRows.length + 1 + caretPlaced.line
      : caretPlaced.line
  const caretCharCol = caretPlaced.charCol
  const caretVisualCol = caretPlaced.visualCol

  // Fold stats describe the BLOCK (or the whole input when expanded and
  // the ▾ prefix offers a manual whole-input fold). The chip shows the
  // block's own line/char count + first-line preview — the preview text
  // around it is unaffected.
  const big = isBigInput(foldText)
  const stats = big
    ? t('input-fold-stats', { lines: foldText.split('\n').length, chars: foldText.length })
    : ''
  const peekOpen = block !== null && hovered && !selectionActive

  // 展开态的编辑区行高预算：圆角边框 2 + 标题行 1 + 状态行 1 + 按钮行 1。
  const editorMaxRows = Math.max(1, terminalRows - EDITOR_CHROME_ROWS)
  if (expanded && caretVisualLine !== prevCaretLineRef.current) {
    // A real caret move re-engages following after wheel browsing.
    editorFreeScrollRef.current = false
    prevCaretLineRef.current = caretVisualLine
  }
  let windowStart: number
  let visibleCount: number
  if (expanded) {
    // 滚轮推动的窗口与 caret 跟随合并：自由滚动（滚轮浏览）期间不强制
    // caret 可见；caret 移动后恢复跟随。写回 ref，滚轮分支读到的就是
    // 合并后的基线。
    let win = expandedScrollRef.current
    if (!editorFreeScrollRef.current) {
      if (caretVisualLine < win) win = caretVisualLine
      if (caretVisualLine >= win + editorMaxRows) win = caretVisualLine - editorMaxRows + 1
    }
    win = Math.max(0, Math.min(win, Math.max(0, visualLines.length - editorMaxRows)))
    expandedScrollRef.current = win
    windowStart = win
    visibleCount = editorMaxRows
  } else {
    windowStart = Math.max(
      0,
      Math.min(
        caretVisualLine - MAX_VISIBLE_LINES + 1,
        visualLines.length - MAX_VISIBLE_LINES,
      ),
    )
    visibleCount = MAX_VISIBLE_LINES
  }
  const visibleLines = visualLines.slice(
    windowStart,
    windowStart + visibleCount,
  )
  // useInput 的滚轮分支需要这份几何（它在这些派生之前注册）。
  if (expanded) {
    editorViewportRef.current = { maxRows: editorMaxRows, total: visualLines.length }
  }

  // Folded chip content: block stats + first-line preview + hover hint,
  // all pre-truncated to the input width (the row is one line, always).
  const foldBadge = `▸ ${stats}`
  const foldHint = t('input-fold-hover')
  const foldPreviewWidth =
    inputWidth - stringWidth(foldBadge) - stringWidth(` · ${foldHint}`) - 6
  const foldPreview =
    foldPreviewWidth >= 8
      ? truncateToWidth(foldText.split('\n')[0] ?? '', foldPreviewWidth)
      : ''

  // Expanded-state fold affordance: a `▾` prefix at the start of the FIRST
  // row (only while the window is at the top and no block exists); its
  // cells fold the whole input into a block again on click.
  const prefixLabel = `▾ ${stats} · `
  const prefixCols =
    !block && !expanded && big && windowStart === 0 ? stringWidth(prefixLabel) : 0

  // Offset range [start, end) of every visual row — the SAME break rule as
  // wrapToWidth — so the selection highlight can intersect each row. With a
  // fold block, the chip row maps to the block's own span (never selected:
  // updateSelection clamps the selection into the head or the tail side).
  const lineRanges: Array<[number, number]> = block
    ? [
        ...visualLineRanges(head, inputWidth),
        [block.start, block.end],
        ...visualLineRanges(tail, inputWidth).map(
          ([s, e]): [number, number] => [s + block.end, e + block.end],
        ),
      ]
    : visualLineRanges(value, inputWidth)

  /**
   * Inverse runs for one rendered row, shared by the inline prompt and the
   * expanded editor: the selection's intersection (if any) and the caret
   * cluster on the caret's row. Both render <Text inverse>; overlapping
   * intervals merge so a caret inside the selection stays one continuous
   * highlight. The caret row inverts the WHOLE cluster at the caret column
   * (solid block) — [col, next boundary) covers a surrogate pair or ZWJ
   * emoji as one glyph; at the text end it shows a blank inverse cell like
   * the empty-input caret (appended after everything, so a selection
   * ending there cannot swallow it).
   */
  const rowHighlightPieces = (
    text: string,
    absoluteLine: number,
  ): Array<{ text: string; inverse: boolean }> => {
    const intervals: Array<[number, number]> = []
    const sel = selection
    if (sel) {
      const [rowStart, rowEnd] = lineRanges[absoluteLine] ?? [0, 0]
      const lo = Math.min(Math.max(sel.start - rowStart, 0), text.length)
      const hi = Math.min(Math.max(sel.end - rowStart, 0), text.length)
      if (hi > lo) intervals.push([lo, hi])
    }
    let endBlankCaret = false
    if (absoluteLine === caretVisualLine) {
      const col = Math.min(caretCharCol, text.length)
      const clusterEnd = nextGraphemeBoundary(graphemeBoundaries(text), col)
      if (clusterEnd > col) intervals.push([col, clusterEnd])
      else endBlankCaret = col === text.length
    }
    intervals.sort((a, b) => a[0] - b[0])
    const runs: Array<[number, number]> = []
    for (const [s, e] of intervals) {
      const last = runs[runs.length - 1]
      if (last && s <= last[1]) last[1] = Math.max(last[1], e)
      else runs.push([s, e])
    }
    const pieces: Array<{ text: string; inverse: boolean }> = []
    let pos = 0
    for (const [s, e] of runs) {
      if (s > pos) pieces.push({ text: text.slice(pos, s), inverse: false })
      pieces.push({ text: text.slice(s, e), inverse: true })
      pos = Math.max(pos, e)
    }
    if (pos < text.length) pieces.push({ text: text.slice(pos), inverse: false })
    if (endBlankCaret) pieces.push({ text: ' ', inverse: true })
    return pieces
  }

  const rendered = visibleLines.map((line, index) => {
    const absoluteLine = windowStart + index
    if (block && absoluteLine === chipRow) {
      // The fold block's atomic chip row: click expands it; hover pops the
      // peek card. The row is one line no matter how big the block is.
      return (
        <Box
          key={`fold-${absoluteLine}`}
          flexDirection="row"
          onClick={(event) => {
            event.stopImmediatePropagation()
            updateFoldBlock(null)
          }}
          onMouseEnter={hoverEnter}
          onMouseLeave={hoverLeave}
        >
          <Text dimColor>{foldBadge}</Text>
          {foldPreview !== '' && <Text dimColor> · </Text>}
          {foldPreview !== '' && <Text wrap="truncate-end">{foldPreview}</Text>}
          <Text dimColor>{` · ${foldHint}`}</Text>
        </Box>
      )
    }
    const withPrefix = absoluteLine === 0 && prefixCols > 0
    const text = withPrefix ? truncateToWidth(line, inputWidth - prefixCols) : line
    const prefix = withPrefix ? <Text dimColor>{prefixLabel}</Text> : null
    const pieces = rowHighlightPieces(text, absoluteLine)
    return (
      <Text key={absoluteLine} wrap="truncate-end">
        {prefix}
        {pieces.length === 0 ? ' ' : pieces.map((piece, pieceIndex) =>
          piece.inverse ? (
            <Text key={pieceIndex} inverse>
              {piece.text}
            </Text>
          ) : (
            piece.text
          ),
        )}
      </Text>
    )
  })

  // ── 展开态编辑行 ────────────────────────────────────────────────────
  // Logical line number per visual row (a wrapped continuation keeps its
  // line's number): the row's range end sitting on a '\n' starts a new
  // logical line from the NEXT row.
  const editorRowLogical: number[] = []
  if (expanded) {
    let count = 0
    for (let i = 0; i < lineRanges.length; i++) {
      editorRowLogical.push(count)
      const rangeEnd = lineRanges[i]![1]
      if (value[rangeEnd] === '\n') count++
    }
  }
  const editorRows = expanded
    ? visibleLines.map((line, index) => {
        const absoluteLine = windowStart + index
        const isCaretRow = absoluteLine === caretVisualLine
        const logicalNo = editorRowLogical[absoluteLine]
        const gutterLabel =
          logicalNo === undefined
            ? ' '.repeat(editorNoWidth)
            : String(logicalNo + 1).padStart(editorNoWidth, ' ')
        const pieces = rowHighlightPieces(line, absoluteLine)
        return (
          <Text
            key={absoluteLine}
            wrap="truncate-end"
            backgroundColor={isCaretRow ? 'toolCardBackgroundDim' : undefined}
          >
            <Text
              dimColor={!isCaretRow}
              bold={isCaretRow}
              color={isCaretRow ? promptAccent : undefined}
            >
              {`${gutterLabel} │ `}
            </Text>
            {pieces.map((piece, pieceIndex) =>
              piece.inverse ? (
                <Text key={pieceIndex} inverse>
                  {piece.text}
                </Text>
              ) : (
                piece.text
              ),
            )}
          </Text>
        )
      })
    : null

  // Peek card content: the BLOCK's text wrapped to the card's inner width,
  // capped at PEEK_MAX_ROWS visual rows (a preview — click to expand and
  // edit the real input). The footer reports the clipped remainder.
  const PEEK_MAX_ROWS = 10
  const peekVisualLines: string[] = []
  for (const line of foldText.split('\n')) {
    for (const row of wrapToWidth(line, cardContentWidth(columns))) {
      if (peekVisualLines.length >= PEEK_MAX_ROWS) break
      peekVisualLines.push(row)
    }
    if (peekVisualLines.length >= PEEK_MAX_ROWS) break
  }
  const peekClipped = peekVisualLines.length >= PEEK_MAX_ROWS

  // Composer height shrink: clearing multi-line text (Enter/Esc/Ctrl+C/
  // Backspace) collapses the input area within one commit, shifting the
  // status line up and the whole chrome with it. The renderer's
  // full-damage pass (didLayoutShift) repaints the shifted siblings, but
  // inline mode's virtual↔scrollback correspondence needs the stronger
  // in-place viewport repaint — same treatment as Ctrl+O and the
  // loaded-context toggle (see Chat.tsx). One-shot, only on SHRINK:
  // growth scrolls the terminal naturally and needs no recovery.
  const contentRows = value.length === 0 ? 1 : visibleLines.length
  noteAuxNumber('promptContentRows', contentRows)
  const prevContentRowsRef = React.useRef(contentRows)
  React.useLayoutEffect(() => {
    if (contentRows < prevContentRowsRef.current) {
      const ink = instances.get(process.stdout) ?? instances.values().next().value
      ink?.invalidatePrevFrame()
      ink?.reanchorViewport()
    }
    prevContentRowsRef.current = contentRows
  }, [contentRows])

  const lastNotification =
    channel.notifications[channel.notifications.length - 1]

  // Park the native terminal cursor at the input caret (via the renderer's
  // cursor-declaration mechanism). Terminal emulators render IME preedit
  // text and screen-reader focus at the physical cursor, so parking it at
  // the caret makes CJK/IME composition appear inline at the input instead
  // of at the screen's bottom row; in line-mode terminals the console echo
  // of typed characters lands at the same spot. `line`/`column` are
  // relative to the value box the ref attaches to.
  const valueBoxRef = useDeclaredCursor({
    line: caretVisualLine - windowStart,
    // Clamp the declared column to the wrap width: a grapheme wider than
    // the last remaining column (emoji at width 1) can push the visual
    // column past inputWidth, and the park must stay inside the value box.
    // In the expanded editor the declared box starts at its outer edge
    // (padding + gutter included), so those columns ride along and the
    // clamp grows with them.
    column: Math.min(
      caretVisualCol +
        (expanded
          ? editorGutterCols + 1
          : caretVisualLine === 0 && prefixCols > 0
            ? prefixCols
            : 0),
      expanded ? editorGutterCols + 1 + inputWidth : inputWidth,
    ),
    active: !selectionActive,
  })

  /**
   * Map a pointer position relative to the value box to a UTF-16 offset
   * via the same grapheme walk the renderer wraps with — exact under CJK
   * widths, wrapped rows and multi-codepoint clusters. Rows are clamped to
   * the VISIBLE window (drag moves never auto-scroll past it in v1); the
   * fold chip row maps to null (its cells belong to the expand affordance,
   * not to text).
   */
  const localToOffset = (localCol: number, localRow: number): number | null => {
    const lastVisible = Math.min(visualLines.length - 1, windowStart + visibleCount - 1)
    const clamped = Math.max(windowStart, Math.min(windowStart + localRow, lastVisible))
    // Fold prefix (▾) row: the rendered first row is truncated by prefixCols,
    // so both the column and the wrap budget shift — without the correction
    // a drag starting on the first row lands prefixCols to the right of the
    // pointer (parity with handleValueClick's click mapping). Presses ON the
    // prefix cells clamp to the row start (drag-from-0, like selecting the
    // whole first row backwards).
    const isPrefixRow = !block && clamped === 0 && prefixCols > 0
    const col = isPrefixRow ? Math.max(0, localCol - prefixCols) : localCol
    const width = isPrefixRow ? inputWidth - prefixCols : inputWidth
    if (block) {
      if (clamped === chipRow) return null
      return clamped < chipRow
        ? clickToCursorOffset(head, width, clamped, col)
        : block.end + clickToCursorOffset(tail, width, clamped - chipRow - 1, col)
    }
    return clickToCursorOffset(value, width, clamped, col)
  }

  /**
   * Click-to-position the caret: map a click inside the value box (local
   * row/column relative to the box) to a UTF-16 cursor offset via the same
   * grapheme walk the renderer wraps with — exact under CJK widths, wrapped
   * rows and multi-codepoint clusters. Clicks land on the boundary nearest
   * the clicked cell (mid-grapheme snaps to its start). With a fold block,
   * clicks map into the head/tail text (the chip row has its own expand
   * onClick); without one, the fold prefix's cells fold the whole input.
   *
   * The drag protocol resets ink's multi-click chain on every press inside
   * the value box (it carries onDragStart), so double-click word selection
   * is self-detected here: two clicks within DOUBLE_CLICK_MS and one cell.
   * Shift+click extends the selection from its start edge (or the caret)
   * to the clicked offset; a plain click clears the selection and moves
   * the caret.
   *
   * `colOffset` shifts the local column origin: the expanded editor's
   * value box starts at the line-number gutter, so its callers subtract
   * the gutter width (0 for the inline prompt).
   */
  const handleValueClick = (e: ClickEvent, colOffset = 0) => {
    const now = Date.now()
    const modified = e.shift || e.alt || e.ctrl
    const isDouble =
      !modified &&
      now - lastClickAtRef.current < DOUBLE_CLICK_MS &&
      Math.abs(e.col - lastClickColRef.current) <= 1 &&
      Math.abs(e.row - lastClickRowRef.current) <= 1
    if (modified) {
      // Shift+click is range extension, never a word-select click. It also
      // breaks the local chain so a following plain click cannot complete a
      // double-click that started under a modifier.
      lastClickAtRef.current = 0
      lastClickColRef.current = -1
      lastClickRowRef.current = -1
    } else {
      lastClickAtRef.current = now
      lastClickColRef.current = e.col
      lastClickRowRef.current = e.row
    }
    const localCol = e.localCol - colOffset
    const clickedVisual = windowStart + e.localRow
    const clamped = Math.max(0, Math.min(clickedVisual, visualLines.length - 1))
    if (block) {
      if (clamped === chipRow) return
      const offset =
        clamped < chipRow
          ? clickToCursorOffset(head, inputWidth, clamped, localCol, isDouble ? 'grapheme-start' : 'nearest')
          : block.end + clickToCursorOffset(tail, inputWidth, clamped - chipRow - 1, localCol, isDouble ? 'grapheme-start' : 'nearest')
      if (isDouble) {
        // Word select stays inside the clicked side: the block is atomic.
        const side = offset <= block.start
        const w = wordSelectionAt(value, offset, side ? 0 : block.end, side ? block.start : value.length)
        if (w) {
          updateSelection(w.start, w.end)
          setCursor(w.end)
        }
        return
      }
      if (e.shift) {
        const base = selectionRef.current ? selectionRef.current.start : cursorRef.current
        updateSelection(base, offset)
        setCursor(offset)
        return
      }
      clearSelection()
      setCursor(offset)
      return
    }
    if (clamped === 0 && prefixCols > 0 && localCol < prefixCols) {
      // Folding hides the entire editable projection, so no selection may
      // survive invisibly inside the chip and keep owning Ctrl+C/Delete.
      clearSelection()
      dragAnchorRef.current = null
      setCursor(value.length)
      updateFoldBlock({ start: 0, end: value.length })
      return
    }
    const col =
      clamped === 0 && prefixCols > 0 ? Math.max(0, localCol - prefixCols) : localCol
    const offset = clickToCursorOffset(
      value,
      clamped === 0 && prefixCols > 0 ? inputWidth - prefixCols : inputWidth,
      clamped,
      col,
      isDouble ? 'grapheme-start' : 'nearest',
    )
    if (isDouble) {
      const w = wordSelectionAt(value, offset, 0, value.length)
      if (w) {
        updateSelection(w.start, w.end)
        setCursor(w.end)
      }
      return
    }
    if (e.shift) {
      const base = selectionRef.current ? selectionRef.current.start : cursorRef.current
      updateSelection(base, offset)
      setCursor(offset)
      return
    }
    clearSelection()
    setCursor(offset)
  }

  /**
   * Drag selection (component-level drag protocol): the press origin is
   * derived from the event's start/current delta (dragstart fires on the
   * FIRST motion), the focus follows every dragmove. The caret rides the
   * focus edge; updateSelection clamps both ends into one fold side, so a
   * drag can never cross the chip row. `colOffset` as in handleValueClick.
   */
  const handleDragStart = (e: DragEvent, colOffset = 0) => {
    const anchorLocalCol = e.localCol - (e.col - e.startCol) - colOffset
    const anchorLocalRow = e.localRow - (e.row - e.startRow)
    const anchor = localToOffset(anchorLocalCol, anchorLocalRow)
    if (anchor === null) {
      dragAnchorRef.current = null
      return
    }
    dragAnchorRef.current = anchor
    setCursor(anchor)
  }
  const handleDragMove = (e: DragEvent, colOffset = 0) => {
    const anchor = dragAnchorRef.current
    if (anchor === null) return
    const focus = localToOffset(e.localCol - colOffset, e.localRow)
    if (focus === null) return
    // The caret rides the focus edge, clamped into the anchor's fold side
    // exactly like updateSelection clamps the range — the caret must never
    // jump across the chip row while the selection stays behind.
    let caret = focus
    const block = foldBlockRef.current
    if (block) {
      caret = anchor <= block.start ? Math.min(focus, block.start) : Math.max(focus, block.end)
    }
    updateSelection(anchor, focus)
    setCursor(normalizeCursorOffset(valueRef.current, caret))
  }
  const handleDragEnd = () => {
    dragAnchorRef.current = null
  }

  // 浮层整体挂载条件：与内部面板可见条件精确同值。关闭时必须把整个
  // absolute 浮层移除——渲染器的 absolute-removed 检测只看被移除节点自身
  // 的 style.position，常驻浮层 + 移除普通子节点不会触发 blit 解毒，被
  // 覆盖的转录行会留空（见 Chat.tsx dialogOverlayOpen 注释）。展开态由
  // 全屏编辑器接管，内联浮层全部撤下。
  const floatersOpen =
    !expanded &&
    (helpOpen || channel.pending.length > 0 || fileOverlayOpen || overlayOpen || peekOpen)
  // 顶边框右侧的会话名标签（CC 风格 chip）：色随强调色；超宽截断，宽度
  // 随终端列数伸缩但不超过 28 显示单元。默认关闭——`/settings` 的
  // 「会话名标签」开关（dsh-tui.promptSessionLabel）开启后显示。
  const sessionTitle = channel.sessionTitle ?? ''
  const topRightLabel: InputBorderLabel | undefined =
    channel.promptSessionLabel === true && sessionTitle !== ''
      ? {
          text: truncateToWidth(sessionTitle, Math.max(8, Math.min(28, columns - 8))),
          color: channel.mode.plan === true ? 'planMode' : (sessionAccent ?? 'claude'),
          ink: 'inverseText',
        }
      : undefined

  // 浮层最佳路径（/ 命令卡、@ 文件卡、帮助/队列）经渲染器 absolute-overlay
  // 机制覆盖转录尾部与状态行。若覆盖期间上方兄弟重绘（spinner 滴答、流式
  // 文本），覆盖单元格会混入 prevScreen 的旧转录内容——"重叠变花"的根因
  // （渲染器注释描述的同族问题）。Chat.tsx 对其浮层/高度切换都做视口重锚
  // （Ctrl+O、loaded-context）；此处为斜杠/文件浮层的开关补上同样的恢复：
  // 打开时保证卡片整块重绘、关闭时保证被覆盖行回到干净的转录内容，而非与
  // scrollback 失同步后残留花屏。
  const prevFloatersOpenRef = React.useRef(floatersOpen)
  React.useLayoutEffect(() => {
    if (floatersOpen === prevFloatersOpenRef.current) return
    prevFloatersOpenRef.current = floatersOpen
    const ink = instances.get(process.stdout) ?? instances.values().next().value
    ink?.invalidatePrevFrame()
    ink?.reanchorViewport()
  }, [floatersOpen])

  // 展开态开关 = 全屏覆盖增删：与浮层开关同款的视口重锚（inline 模式的
  // 虚屏↔scrollback 映射不漂移），并在展开首帧把滚动窗口归零。
  React.useLayoutEffect(() => {
    if (expanded === prevExpandedRef.current) return
    prevExpandedRef.current = expanded
    if (expanded) expandedScrollRef.current = 0
    const ink = instances.get(process.stdout) ?? instances.values().next().value
    ink?.invalidatePrevFrame()
    ink?.reanchorViewport()
  }, [expanded])

  // Feature turned off mid-session while the editor is up: withdraw the
  // cover (the draft and every other editing state survive).
  React.useEffect(() => {
    if (expanded && !expandEnabled) collapseEditor()
  }, [expanded, expandEnabled])

  // ── 全屏草稿编辑节点 ────────────────────────────────────────────────
  // 每次渲染构造新鲜闭包（value/caret/handlers），经 module store 发布给
  // Chat 根部末尾的 PromptEditorLayer（树序最后 → 盖住全部后绘兄弟）。
  // useInsertionEffect 发布：sink 的同步重渲染发生在 layout 阶段之前，
  // useDeclaredCursor（layout effect）读到的新 ref 已指向编辑区 Box。
  // 点击/拖拽坐标以内容区为原点（localCol 去掉行号槽宽度）。
  const editorNode = expanded ? (
    <Box
      flexDirection="column"
      width="100%"
      height="100%"
      borderStyle="round"
      borderColor={promptAccent}
      backgroundColor="toolCardBackground"
    >
      {/* 标题行：编辑图标 + 标题 · 右侧实时统计 */}
      <Box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
        <Text bold color={promptAccent}>{`✎ ${t('input-expand-editor-title')}`}</Text>
        <Box flexGrow={1} />
        <Text dimColor>
          {t('input-fold-stats', {
            lines: value.split('\n').length,
            chars: value.length,
          })}
        </Text>
      </Box>
      {/* 编辑区：行号槽 + 全套选区/caret 高亮，点击定位/拖选/双击选词。
          坐标换算：localCol 相对 Box 外缘（含 paddingLeft），故偏移 =
          padding 1 + 行号槽宽（见 handleValueClick 的 colOffset）。滚轮走
          位置路由（onWheel），驱动展开态自己的滚动窗口。 */}
      <Box
        ref={valueBoxRef}
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        paddingLeft={1}
        paddingRight={1}
        onClick={(event) => {
          handleValueClick(event, editorGutterCols + 1)
        }}
        onDragStart={(event) => {
          handleDragStart(event, editorGutterCols + 1)
        }}
        onDragMove={(event) => {
          handleDragMove(event, editorGutterCols + 1)
        }}
        onDragEnd={handleDragEnd}
        onWheel={(event) => {
          const viewport = editorViewportRef.current
          if (!viewport) return
          editorFreeScrollRef.current = true
          const max = Math.max(0, viewport.total - viewport.maxRows)
          expandedScrollRef.current = Math.max(
            0,
            Math.min(expandedScrollRef.current + Math.round(event.deltaY), max),
          )
          setExpandedTick(tick => tick + 1)
        }}
      >
        {editorRows}
      </Box>
      {/* 状态行：vim 徽标 · 行列 · 右侧键位提示 */}
      <Box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
        {vimEnabled && (
          <Text bold color={vimInsert ? 'success' : 'warning'}>
            {vimInsert ? 'INSERT' : 'NORMAL'}{' '}
          </Text>
        )}
        <Text dimColor>
          {t('input-expand-editor-position', {
            line: cursorLine(value, cursor) + 1,
            col: cursorColumn(value, cursor) + 1,
          })}
        </Text>
        <Box flexGrow={1} />
        <Text dimColor>
          {`${t('input-expand-editor-hint-send')} · ${t('input-expand-editor-hint-collapse')}`}
        </Text>
      </Box>
      {/* 按钮行：主操作发送（accent 填充）+ 次操作收起，均可点击/hover */}
      <Box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1} columnGap={1}>
        <EditorButton
          label={`⏎ ${t('input-expand-editor-send')}`}
          hint="Ctrl+Enter"
          primary
          accent={promptAccent}
          onClick={submitFromEditor}
        />
        <EditorButton
          label={t('input-expand-editor-collapse')}
          hint="Esc"
          onClick={collapseEditor}
        />
        <Box flexGrow={1} />
        <Text dimColor>{t('input-expand-editor-scroll')}</Text>
      </Box>
    </Box>
  ) : null
  React.useInsertionEffect(() => {
    setPromptEditorNode(editorNode)
  })
  React.useEffect(() => {
    // 卸载保险：PromptInput 被替换（问卷/面板接管）时撤下全屏浮层。
    return () => {
      setPromptEditorNode(null)
    }
  }, [])

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* 瞬态面板浮层（帮助/队列/补全）：零布局高度、向上覆盖转录尾部，
          帧高不随面板开关涨落——否则帧顶行会被滚进 scrollback 并在关闭
          重绘时二次写入（/model 切换多一份启动画的根因，见 OverlayAbove）。 */}
      {floatersOpen && (
      <OverlayAbove maxHeight={Math.max(terminalRows - 6, 1)}>
        {helpOpen && (
          <Box marginBottom={1}>
            <HelpMenu
              commands={channel.commandList}
              viewportHeight={helpViewportHeight}
              viewportWidth={columns}
              scrollRef={helpScrollRef}
              onCommandPick={(name) => {
                // 点击命令行 = 填入 /name 并关闭帮助（Tab 补全的鼠标等价）
                updateFoldBlock(null)
                setInput(`/${name} `)
                onToggleHelp()
              }}
            />
          </Box>
        )}
        {!helpOpen && channel.pending.length > 0 && (
          <Box flexDirection="column" paddingLeft={2} paddingBottom={1}>
            {channel.pending.some(item => item.placement === 'steer') && (
              <Box flexDirection="column">
                <Text dimColor>⚡ {t('input-pending-steer-label')}</Text>
                {channel.pending
                  .filter(item => item.placement === 'steer')
                  .map(item => (
                    <Text key={item.id} dimColor wrap="truncate">
                      {'  '}↳ {item.text}
                    </Text>
                  ))}
              </Box>
            )}
            {channel.pending.some(item => item.placement === 'followup') && (
              <Box flexDirection="column">
                <Text dimColor>⏳ {t('input-pending-queue-label')}</Text>
                {channel.pending
                  .filter(item => item.placement === 'followup')
                  .map(item => (
                    <Text key={item.id} dimColor wrap="truncate">
                      {'  '}↳ {item.text}
                    </Text>
                  ))}
              </Box>
            )}
            <Text dimColor>Alt+↑ {t('input-pending-actions-hint')}</Text>
          </Box>
        )}
        {fileOverlayOpen && (
          <FileSuggestions
            files={fileMatches}
            selectedIndex={fileSelected}
            columns={columns}
            query={mention?.query ?? ''}
            accent={promptAccent}
            // 点击行 = 接受该项（与 Enter 同路径）
            onPick={(index) => {
              const file = fileMatches[index]
              if (file) acceptFile(file)
            }}
            // 滚轮 = 移动选中行（与 ↑/↓ 同路径，窗口跟随）
            onWheelStep={(step) => {
              setFileSelected(i => Math.max(0, Math.min(fileMatches.length - 1, i + step)))
            }}
          />
        )}
        {overlayOpen && (
          <CommandSuggestions
            commands={suggestions}
            selectedIndex={selectedCommand}
            columns={columns}
            query={value}
            accent={promptAccent}
            // 点击行 = 运行该命令（与 Enter 同路径）
            onPick={(index) => {
              const command = suggestions[index]
              if (command) tryRunCommand(command.commandLine)
            }}
            // 滚轮 = 移动选中行（与 ↑/↓ 同路径，窗口跟随）
            onWheelStep={(step) => {
              setSelectedCommand(i => Math.max(0, Math.min(suggestions.length - 1, i + step)))
            }}
          />
        )}
        {peekOpen && (
          // 悬停预览卡片：只读展示折叠内容的头部（输入框自身保持一行，
          // 布局零跳动）。点击任一行 = 固定展开进入真实输入框编辑；悬停
          // 期间鼠标直接打字同样先展开（见折叠态按键分支）。卡片自身的
          // enter/leave 维持 hovered，防止 chip→卡片过渡闪烁。
          <Box onMouseEnter={hoverEnter} onMouseLeave={hoverLeave}>
            <SuggestionCard
              title={stats}
              columns={columns}
              accent={promptAccent}
              footer={
                peekClipped
                  ? t('input-fold-peek-footer', { lines: foldText.split('\n').length })
                  : undefined
              }
              rows={peekVisualLines.map((row, index) => (
                <Text key={index} wrap="truncate-end">
                  {row}
                </Text>
              ))}
              onRowPick={() => {
                updateFoldBlock(null)
                setHovered(false)
              }}
            />
          </Box>
        )}
      </OverlayAbove>
      )}
      {lastNotification && (
        // position=absolute takes zero layout height so the transcript never
        // shifts when a notification appears/disappears; the layer floats one
        // row above the prompt border, right-aligned (CC's Notifications).
        <Box
          position="absolute"
          marginTop={-1}
          height={1}
          width="100%"
          paddingLeft={2}
          paddingRight={1}
          flexDirection="column"
          justifyContent="flex-end"
          overflow="hidden"
        >
          <Box justifyContent="flex-end">
            <Text
              color={lastNotification.color}
              dimColor={!lastNotification.color}
              wrap="truncate"
            >
              {lastNotification.text}
            </Text>
          </Box>
        </Box>
      )}
      {/* The prompt's own top/bottom border rows, self-drawn so the effort
          overlay can play on them (sweep → tier name → fade; see
          EffortInputBorder). Idle colour keeps the plan-mode accent the old
          Box border carried. */}
      <EffortInputBorder
        effort={channel.reasoningEffort}
        levels={channel.effortLevels}
        columns={columns}
        onLight={isLightThemeActive(themeName)}
        idleColor={promptAccent}
        topRightLabel={topRightLabel}
      >
        <Box flexDirection="row" alignItems="flex-start" width="100%">
          <EffortChargeGlyph
            effort={channel.reasoningEffort}
            levels={channel.effortLevels}
            working={channel.working}
          />
          {vimEnabled && (
            <Text bold color={vimInsert ? 'success' : 'warning'}>
              {vimInsert ? 'INSERT' : 'NORMAL'} </Text>
          )}
          <Box
            ref={expanded ? undefined : valueBoxRef}
            flexGrow={1}
            flexShrink={1}
            onClick={handleValueClick}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
          >
            {value.length === 0 ? (
              // Solid block caret on a BLANK cell: the terminal paints the
              // IME preedit (pinyin) at the physical cursor, which is parked
              // right here, so nothing else may occupy this cell.
              <>
                <Text inverse> </Text>
                {/* 三幕点焰第二幕：空输入行居中短暂浮现档名大写（纯文
                    本流自带偏移空格——不引入嵌套 Box，行数恒定；有文字
                    时不显示）。 */}
                <EffortTierBadge
                  effort={channel.reasoningEffort}
                  levels={channel.effortLevels}
                  onLight={isLightThemeActive(themeName)}
                  columns={columns}
                  leadingColumns={3}
                />
              </>
            ) : (
              <Box flexDirection="column">{rendered}</Box>
            )}
          </Box>
          {/* ⛶ 全屏草稿编辑入口：点击展开；hover 提亮为输入框强调色。
              inputWidth 已为它预留 2 列（见渲染派生区）；设置关闭时
              整体不渲染（宽度预算同步归还）。 */}
          {expandEnabled && (
            <Box
              flexShrink={0}
              onClick={(event) => {
                event.stopImmediatePropagation()
                toggleExpand()
              }}
              onMouseEnter={() => {
                setExpandHovered(true)
              }}
              onMouseLeave={() => {
                setExpandHovered(false)
              }}
            >
              <Text
                dimColor={!expandHovered}
                bold={expandHovered}
                color={expandHovered ? promptAccent : undefined}
              >
                ⛶
              </Text>
            </Box>
          )}
        </Box>
      </EffortInputBorder>
      {/* CC agent-view footer: "← N agents" when background sessions are
          waiting on the user, "← for agents" otherwise — the ← affordance's
          discoverability hint. Only rendered when the Chat screen supplies
          the count. */}
      {backgroundAgentsNeedingInput !== undefined && (
        <Box flexDirection="row" justifyContent="flex-end" paddingRight={2}>
          <Text dimColor>
            {backgroundAgentsNeedingInput > 0
              ? t('input-background-hint-count', { n: backgroundAgentsNeedingInput })
              : t('input-background-hint-idle')}
          </Text>
        </Box>
      )}
    </Box>
  )
}

/**
 * Grapheme word-wrap for one logical line: break at the last space when
 * the row overflows; hard-wrap a word that cannot fit; never split a
 * cluster (ZWJ emoji, combining sequences, CJK wide cells stay whole).
 */
function wrapLineRows(
  line: string,
  width: number,
): Array<{ start: number; end: number }> {
  if (line === '') return [{ start: 0, end: 0 }]
  const rows: Array<{ start: number; end: number }> = []
  const segmenter = getGraphemeSegmenter()
  let rowStart = 0
  let currentWidth = 0
  let offset = 0
  let lastBreak = -1
  for (const { segment } of segmenter.segment(line)) {
    const w = stringWidth(segment)
    while (currentWidth + w > width && offset > rowStart) {
      if (lastBreak > rowStart) {
        rows.push({ start: rowStart, end: lastBreak })
        rowStart = lastBreak
        currentWidth = stringWidth(line.slice(rowStart, offset))
        lastBreak = -1
      } else {
        rows.push({ start: rowStart, end: offset })
        rowStart = offset
        currentWidth = 0
        lastBreak = -1
      }
    }
    currentWidth += w
    offset += segment.length
    if (segment === ' ') lastBreak = offset
  }
  rows.push({ start: rowStart, end: offset })
  return rows
}

/** Wrap text to `width` columns via {@link wrapLineRows} (newlines honoured). */
function wrapToWidth(text: string, width: number): string[] {
  return text.split('\n').flatMap(line =>
    wrapLineRows(line, width).map(r => line.slice(r.start, r.end)),
  )
}

/**
 * Locate `offset` in the wrapped layout of `text`. Uses the full wrap —
 * not a prefix — so a cursor inside a carried word maps to the displayed
 * row. At a wrap join the caret stays on the earlier row (after the space).
 */
function caretInText(
  text: string,
  width: number,
  offset: number,
): { line: number; charCol: number; visualCol: number } {
  let line = 0
  let lineBase = 0
  let last = { line: 0, charCol: 0, visualCol: 0 }
  for (const logical of text.split('\n')) {
    for (const r of wrapLineRows(logical, width)) {
      const start = lineBase + r.start
      const charCol = Math.max(0, offset - start)
      last = {
        line,
        charCol,
        visualCol: stringWidth(logical.slice(r.start, r.start + charCol)),
      }
      if (offset <= lineBase + r.end) return last
      line++
    }
    lineBase += logical.length + 1
  }
  return last
}

/**
 * Inverse of {@link wrapToWidth}: map a click position (visual row index +
 * visual column) back to a UTF-16 offset in the original text. Uses the
 * same {@link wrapLineRows} row boundaries, so every visual row's start
 * offset is known exactly. Within the clicked row, the caret snaps to the
 * boundary nearest the click: a grapheme whose midpoint lies past the
 * click column takes the caret before it, otherwise after.
 */
function clickToCursorOffset(
  text: string,
  width: number,
  visualLine: number,
  visualCol: number,
  snapWithin: 'nearest' | 'grapheme-start' = 'nearest',
): number {
  const segmenter = getGraphemeSegmenter()
  let row = 0
  let lineBase = 0
  for (const line of text.split('\n')) {
    for (const r of wrapLineRows(line, width)) {
      if (row === visualLine) {
        let currentWidth = 0
        let local = 0
        for (const { segment } of segmenter.segment(line.slice(r.start, r.end))) {
          const w = stringWidth(segment)
          // Caret positioning uses the nearest edge. Double-click selection
          // instead needs the grapheme UNDER the cell: on the second cell of a
          // CJK/emoji glyph, nearest-edge would point after the glyph (and the
          // final glyph would select nothing).
          if (snapWithin === 'grapheme-start' && currentWidth + w > visualCol) {
            return lineBase + r.start + local
          }
          if (currentWidth + w / 2 > visualCol) return lineBase + r.start + local
          if (currentWidth + w > visualCol) return lineBase + r.start + local + segment.length
          currentWidth += w
          local += segment.length
        }
        return lineBase + r.end
      }
      row++
    }
    lineBase += line.length + 1
  }
  return lineBase
}

/**
 * Offset range [start, end) of every visual row, using the same {@link
 * wrapLineRows} boundaries as `wrapToWidth`. The selection highlight
 * intersects each row with these ranges so offsets map 1:1 onto the
 * rendered row strings.
 */
function visualLineRanges(text: string, width: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let lineBase = 0
  for (const line of text.split('\n')) {
    for (const r of wrapLineRows(line, width)) ranges.push([lineBase + r.start, lineBase + r.end])
    lineBase += line.length + 1
  }
  return ranges
}

/** Word characters for double-click selection: letters (any script),
 *  digits and the punctuation set terminal emulators treat as word-part by
 *  default (`/usr/bin/bash` selects whole — iTerm2 defaults). */
const WORD_CHAR = /[\p{L}\p{N}_/.\-+~\\]/u

/** Character class for double-click word expansion: whitespace, word
 *  char, everything else (punctuation/symbols). A same-class grapheme
 *  run is one word. */
function selectionCharClass(c: string): 0 | 1 | 2 {
  if (c === '' || /\s/.test(c)) return 0
  if (WORD_CHAR.test(c)) return 1
  return 2
}

/**
 * Word selection around `offset` within [lo, hi): expand left/right over
 * grapheme clusters of the same class as the clicked one (terminal
 * double-click semantics — punctuation runs select as one). Returns null
 * when the offset sits at the range's end (nothing to select).
 */
function wordSelectionAt(
  text: string,
  offset: number,
  lo: number,
  hi: number,
): { start: number; end: number } | null {
  if (offset < lo || offset >= hi) return null
  const bounds = graphemeBoundaries(text.slice(lo, hi)).map(b => b + lo)
  let i = 0
  while (i < bounds.length - 1 && bounds[i + 1]! <= offset) i++
  const clusterAt = (index: number): string => text.slice(bounds[index]!, bounds[index + 1]!)
  const cls = selectionCharClass(clusterAt(i))
  let a = i
  while (a > 0 && selectionCharClass(clusterAt(a - 1)) === cls) a--
  let b = i
  while (b < bounds.length - 2 && selectionCharClass(clusterAt(b + 1)) === cls) b++
  return { start: bounds[a]!, end: bounds[b + 1]! }
}
