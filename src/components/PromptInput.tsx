import React from 'react'
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
import { noteAuxNumber } from '../ink/geometry-trace.js'
import instances from '../ink/instances.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncateToWidth } from '../ink/truncateToWidth.js'
import { getGraphemeSegmenter } from '../utils/intl.js'
import { formatClipboardInsert, readClipboard } from '../utils/clipboard.js'
import { editInExternalEditor } from '../utils/externalEditor.js'
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
 * Imperative handle for the Chat-level Ctrl+C rule: Chat's useInput listener
 * runs BEFORE this component's (EventEmitter registration order), so Chat
 * asks the prompt whether it holds text (→ clear it) or not (→ arm the
 * double-press exit). Populated every render; null while unmounted.
 */
export interface PromptController {
  hasText(): boolean
  clear(): void
}

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
  controllerRef,
}: PromptInputProps) {
  const [themeName] = useTheme()
  const [value, setValue] = React.useState('')
  const [cursor, setCursor] = React.useState(0)
  /**
   * CC-style fold block: the [start, end) span of `value` that renders as
   * a one-line chip while the text around it stays fully editable. Created
   * by a big paste; only an EXPLICIT expand (chip/card click, Esc) or
   * delete removes it — typing NEVER unfolds the block.
   */
  const [foldBlock, setFoldBlock] = React.useState<{ start: number; end: number } | null>(null)
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
        setValue('')
        setCursor(0)
      },
    }
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
    !helpOpen &&
    !selectionActive &&
    fileEscRef.current !== mention?.start

  /** Fold-block state + a synchronous mirror (setInput reads the ref).
   *  Creating a block also drags a caret that sits inside it out to the
   *  block's end (the block is atomic; typing continues after it). */
  const foldBlockRef = React.useRef<{ start: number; end: number } | null>(null)
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
    setValue(next)
    setCursor(offset)
  }

  /**
   * Accept the selected file suggestion: replace ONLY the mention token at
   * the caret (prefix/suffix text survives), quoting whitespace paths. A
   * directory inserts `@dir/` without a trailing space so completion
   * continues into it; a file completes the token with a space.
   */
  const acceptFile = (candidate: FileCandidate) => {
    if (!mention) return
    const file = candidate.path
    const body = /\s/.test(file) ? `@"${file}"` : `@${file}`
    const insert = candidate.kind === 'directory' ? body : `${body} `
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
    appendHistory(trimmed)
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
    appendHistory(trimmed)
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
    appendHistory(trimmed)
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
    appendHistory(trimmed)
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
      appendHistory(text.trim())
    }
    return handled
  }

  /** Clipboard reads are asynchronous; insert against the latest render so
   * typing while PowerShell owns the clipboard never gets overwritten.
   * Returns the resulting value and the insertion offset so callers can
   * apply the paste fold. */
  const insertClipboardAtCaret = (text: string): { next: string; at: number } => {
    const current = valueRef.current
    const position = cursorRef.current
    const next = current.slice(0, position) + text + current.slice(position)
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

    // App deliberately dispatches every parsed key from one stdin read in a
    // single React update. Read the synchronous mirrors so each event sees
    // the text/caret produced by the preceding event in that batch.
    const value = valueRef.current
    const cursor = cursorRef.current

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

    /** Insert text at the caret (typing, paste) and dismiss overlays. */
    const insertAtCaret = (text: string) => {
      if (helpOpen) onToggleHelp()
      const next = value.slice(0, cursor) + text + value.slice(cursor)
      setInput(next, cursor + text.length)
      setSelectedCommand(0)
      setFileSelected(0)
    }

    // Bracketed paste (terminal paste — Ctrl+Shift+V / right-click): insert
    // verbatim at the caret. Paste content may contain newlines — that is
    // NOT Enter — so this branch runs before the whole-line submit rule.
    if (event?.isPasted && input.length > 0) {
      const text = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      insertAtCaret(text)
      // A big paste becomes a CC-style fold block right away (hover peeks
      // at it); an existing block is replaced by the new paste's span.
      if (isBigInput(text)) updateFoldBlock({ start: cursor, end: cursor + text.length })
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
          const text = formatClipboardInsert(content)
          const { at } = insertClipboardAtCaret(text)
          // Same fold as bracketed paste: big clipboard text becomes a
          // fold block covering exactly the pasted span.
          if (isBigInput(text)) updateFoldBlock({ start: at, end: at + text.length })
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

    /**
     * CR/LF line from Windows cmd pipelines):
     * - command menu open → run the SELECTED command (never send `/mo`);
     * - model working → STEER into the running turn (next step boundary,
     *   agent continues — the "immediate" send; Codex/pi semantics);
     * - otherwise → submit directly (or run a unique command).
     */
    const handleEnter = () => {
      // A single Enter can arrive as two events in cmd pipelines (`\r`
      // parsed as return + a raw `\n` line): collapse them so one keypress
      // never sends the message twice.
      const now = Date.now()
      if (now - lastEnterAtRef.current < 80) return
      lastEnterAtRef.current = now
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
        // CC's immediate-command semantics: /btw is exempt from steering —
        // the side question never interrupts the running turn. Hidden
        // UI-only easter eggs (e.g. /deepseek) are also safe to run while
        // streaming. Every other input keeps the steer behavior so /new
        // /model etc. stay idle-only.
        const parsed = value.startsWith('/') ? parseCommandName(value) : undefined
        if (parsed !== undefined && (
          (parsed.name === 'btw' && channel.commandList.some(c => c.name === 'btw'))
          || isHiddenCommandName(parsed.name)
        )) {
          tryRunCommand(value)
          return
        }
        steerSend(value)
        return
      }
      if (!tryRunCommand(value)) submitText(value)
    }

    // Ctrl+J is the only portable multiline fallback when a terminal cannot
    // report modifiers on Enter. The parser names its bare LF `enter`, while
    // the physical Enter key arrives as CR (`return`).
    if (input === '\n' && event?.keypress.name === 'enter') {
      insertAtCaret('\n')
      return
    }

    // Whole-line input from Windows ConPTY pipelines (cmd batch -> node):
    // the trailing CR/LF marks a complete line to submit. A bare CR/CRLF is
    // Enter, while real multi-char piped lines keep the legacy direct-submit
    // path.
    if (input.includes('\n') || input.includes('\r')) {
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
      // Ctrl+Enter / Cmd+Enter: interrupt the running turn and process this
      // message immediately (Windows Terminal sends CSI 13;5u / 13;1;5u).
      interruptSend()
      return
    }
    if (key.return && (key.shift || key.meta)) {
      // Shift+Enter / Option+Enter: insert a newline at the caret
      // (multi-line input). Shift+Enter only arrives when the terminal
      // supports extended key reporting (kitty/modifyOtherKeys allowlist in
      // ink/terminal.ts); Option+Enter (ESC CR) is the fallback on terminals
      // that can't report shift — e.g. macOS Terminal.app (issue #110).
      const next = value.slice(0, cursor) + '\n' + value.slice(cursor)
      setInput(next, cursor + 1)
      setSelectedCommand(0)
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
      if (fileOverlayOpen) {
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
      if (overlayOpen) {
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
      if (fileOverlayOpen) {
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
      if (overlayOpen) {
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
      // bare-arrow arms: Ctrl+Left arrives as leftArrow + ctrl.
      setInput(value, wordBoundaryLeft(value, cursor))
      return
    }
    if (isMod(key) && key.rightArrow) {
      // Jump to the next word boundary (readline alt+f).
      setInput(value, wordBoundaryRight(value, cursor))
      return
    }
    if (key.leftArrow) {
      // Grapheme-step: skip the whole cluster (surrogate pair, ZWJ emoji,
      // combining mark) so the caret never sits inside one.
      setInput(value, previousGraphemeBoundary(bounds, cursor))
      return
    }
    if (key.rightArrow) {
      setInput(value, nextGraphemeBoundary(bounds, cursor))
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
    if (input === '?' && value.length === 0) {
      onToggleHelp()
      return
    }
    if (input && !key.ctrl && !key.meta && !key.super && !key.tab && !key.escape) {
      // Typing anything else dismisses the help menu (CC behavior).
      if (helpOpen) onToggleHelp()
      const next = value.slice(0, cursor) + input + value.slice(cursor)
      setInput(next, cursor + input.length)
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
  const inputWidth = Math.max(1, columns - 3)
  const block = foldBlock
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
  const caretVisualLine = block
    ? cursor <= block.start
      ? wrapToWidth(value.slice(0, cursor), inputWidth).length - 1
      : headRows.length + 1 + wrapToWidth(value.slice(block.end, cursor), inputWidth).length - 1
    : wrapToWidth(value.slice(0, cursor), inputWidth).length - 1

  // Fold stats describe the BLOCK (or the whole input when expanded and
  // the ▾ prefix offers a manual whole-input fold). The chip shows the
  // block's own line/char count + first-line preview — the preview text
  // around it is unaffected.
  const big = isBigInput(foldText)
  const stats = big
    ? t('input-fold-stats', { lines: foldText.split('\n').length, chars: foldText.length })
    : ''
  const peekOpen = block !== null && hovered && !selectionActive

  const windowStart = Math.max(
    0,
    Math.min(
      caretVisualLine - MAX_VISIBLE_LINES + 1,
      visualLines.length - MAX_VISIBLE_LINES,
    ),
  )
  const visibleLines = visualLines.slice(
    windowStart,
    windowStart + MAX_VISIBLE_LINES,
  )

  // Caret position in the caret's visual row, in two units:
  // - char index (for slicing the row's characters in the render below)
  // - visual column (for the physical cursor declaration — CJK characters
  //   occupy TWO terminal columns, so the raw char count would park the
  //   cursor mid-character and Windows Terminal would paint the IME
  //   preedit (pinyin) over the surrounding text).
  const caretCharCol = () => {
    const before =
      block && cursor >= block.end ? value.slice(block.end, cursor) : value.slice(0, cursor)
    const rows = wrapToWidth(before, inputWidth)
    const last = rows[rows.length - 1] ?? ''
    return last.length
  }
  const caretVisualCol = () => {
    const before =
      block && cursor >= block.end ? value.slice(block.end, cursor) : value.slice(0, cursor)
    const rows = wrapToWidth(before, inputWidth)
    const last = rows[rows.length - 1] ?? ''
    return stringWidth(last)
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
  const prefixCols = !block && big && windowStart === 0 ? stringWidth(prefixLabel) : 0

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
    if (absoluteLine !== caretVisualLine) {
      return (
        <Text key={absoluteLine} wrap="truncate-end">
          {prefix}
          {text}
        </Text>
      )
    }
    // Caret row: invert the grapheme cluster at the caret column (solid
    // block). `col` is a cluster boundary by construction (the cursor is
    // normalized onto boundaries and wrapping only breaks between
    // graphemes), so [col, next boundary) covers the WHOLE cluster — a
    // surrogate pair or ZWJ emoji inverts as one glyph, never two broken
    // halves. Clamped into the prefix-shortened row text so the block
    // caret never renders under the fold prefix.
    const col = Math.min(caretCharCol(), text.length)
    const clusterEnd = nextGraphemeBoundary(graphemeBoundaries(text), col)
    const before = text.slice(0, col)
    const at = clusterEnd > col ? text.slice(col, clusterEnd) : ' '
    const after = text.slice(clusterEnd)
    return (
      <Text key={absoluteLine} wrap="truncate-end">
        {prefix}
        {before}
        <Text inverse>{at}</Text>
        {after}
      </Text>
    )
  })

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
    column: Math.min(
      caretVisualCol() + (caretVisualLine === 0 && prefixCols > 0 ? prefixCols : 0),
      inputWidth,
    ),
    active: !selectionActive,
  })

  /**
   * Click-to-position the caret: map a click inside the value box (local
   * row/column relative to the box) to a UTF-16 cursor offset via the same
   * grapheme walk the renderer wraps with — exact under CJK widths, wrapped
   * rows and multi-codepoint clusters. Clicks land on the boundary nearest
   * the clicked cell (mid-grapheme snaps to its start). With a fold block,
   * clicks map into the head/tail text (the chip row has its own expand
   * onClick); without one, the fold prefix's cells fold the whole input.
   */
  const handleValueClick = React.useCallback(
    (e: ClickEvent) => {
      const clickedVisual = windowStart + e.localRow
      const clamped = Math.max(0, Math.min(clickedVisual, visualLines.length - 1))
      if (block) {
        if (clamped === chipRow) return
        if (clamped < chipRow) {
          setCursor(clickToCursorOffset(head, inputWidth, clamped, e.localCol))
        } else {
          setCursor(
            block.end + clickToCursorOffset(tail, inputWidth, clamped - chipRow - 1, e.localCol),
          )
        }
        return
      }
      if (clamped === 0 && prefixCols > 0 && e.localCol < prefixCols) {
        updateFoldBlock({ start: 0, end: value.length })
        return
      }
      const col =
        clamped === 0 && prefixCols > 0 ? Math.max(0, e.localCol - prefixCols) : e.localCol
      setCursor(
        clickToCursorOffset(
          value,
          clamped === 0 && prefixCols > 0 ? inputWidth - prefixCols : inputWidth,
          clamped,
          col,
        ),
      )
    },
    [windowStart, visualLines.length, value, inputWidth, prefixCols, block, chipRow, head, tail],
  )

  // 浮层整体挂载条件：与内部面板可见条件精确同值。关闭时必须把整个
  // absolute 浮层移除——渲染器的 absolute-removed 检测只看被移除节点自身
  // 的 style.position，常驻浮层 + 移除普通子节点不会触发 blit 解毒，被
  // 覆盖的转录行会留空（见 Chat.tsx dialogOverlayOpen 注释）。
  const floatersOpen =
    helpOpen || channel.pending.length > 0 || fileOverlayOpen || overlayOpen || peekOpen
  // 补全卡片边框与输入框 idle 边框同色（plan 模式下整套面板一起变 sage 绿）。
  // `/color` 会话强调色优先于主题 promptBorder（plan 模式仍整体走 sage 绿）。
  // `?? ''` 防御最小 mock channel（只声明用到的字段的回归脚本）。
  const sessionAccent = sessionColorHex(channel.sessionColor ?? '')
  const promptAccent = channel.mode.plan === true ? 'planMode' : (sessionAccent ?? 'promptBorder')
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
          <Box
            ref={valueBoxRef}
            flexGrow={1}
            flexShrink={1}
            onClick={handleValueClick}
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
        </Box>
      </EffortInputBorder>
    </Box>
  )
}

/**
 * Hard-wrap text into visual rows of at most `width` columns (CJK-aware via
 * stringWidth). Used by the input renderer so long lines wrap instead of
 * truncating, with exact caret-row mapping. Wrapping only ever breaks
 * BETWEEN grapheme clusters: iterating code points would split ZWJ emoji
 * and combining sequences across rows, leaving a broken half at each edge
 * and desyncing the caret's row arithmetic (which walks cluster
 * boundaries).
 */
function wrapToWidth(text: string, width: number): string[] {
  const rows: string[] = []
  const segmenter = getGraphemeSegmenter()
  for (const line of text.split('\n')) {
    if (line === '') {
      rows.push('')
      continue
    }
    let current = ''
    let currentWidth = 0
    for (const { segment } of segmenter.segment(line)) {
      const w = stringWidth(segment)
      if (currentWidth + w > width && current !== '') {
        rows.push(current)
        current = segment
        currentWidth = w
      } else {
        current += segment
        currentWidth += w
      }
    }
    rows.push(current)
  }
  return rows
}

/**
 * Inverse of {@link wrapToWidth}: map a click position (visual row index +
 * visual column) back to a UTF-16 offset in the original text. Walks the
 * same grapheme boundaries with the same break rule, so every visual row's
 * start offset is known exactly. Within the clicked row, the caret snaps to
 * the boundary nearest the click: a grapheme whose midpoint lies past the
 * click column takes the caret before it, otherwise after.
 */
function clickToCursorOffset(
  text: string,
  width: number,
  visualLine: number,
  visualCol: number,
): number {
  const segmenter = getGraphemeSegmenter()
  let row = 0
  let offset = 0
  for (const line of text.split('\n')) {
    if (line === '') {
      if (row === visualLine) return offset
      row++
      offset++ // the '\n'
      continue
    }
    let currentWidth = 0
    for (const { segment } of segmenter.segment(line)) {
      const w = stringWidth(segment)
      if (currentWidth + w > width && currentWidth > 0) {
        if (row === visualLine) return offset // end of the clicked wrapped row
        row++
        currentWidth = 0
      }
      if (row === visualLine) {
        if (currentWidth + w / 2 > visualCol) return offset
        if (currentWidth + w > visualCol) return offset + segment.length
      }
      currentWidth += w
      offset += segment.length
    }
    if (row === visualLine) return offset
    row++
    offset++ // the '\n'
  }
  return offset
}
