import React from 'react'
import { readFile, unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { t } from '../i18n.js'
import { Box, Text, useInput, useTerminalSize } from '../ui.js'
import { useDeclaredCursor } from '../ink/hooks/use-declared-cursor.js'
import { stringWidth } from '../ink/stringWidth.js'
import { formatClipboardInsert, readClipboard } from '../utils/clipboard.js'
import { editInExternalEditor } from '../utils/externalEditor.js'
import type { Channel } from '../dsh-adapter/channel.js'
import { parseCommandName } from '../commands.js'
import { appendHistory } from '../history.js'
import { mentionAtCaret } from '../utils/mentions.js'
import { isMod } from '../utils/modifiers.js'
import { CommandSuggestions } from './CommandSuggestions.js'
import { FileSuggestions } from './FileSuggestions.js'
import { HelpMenu } from './HelpMenu.js'
import { OverlayAbove } from './OverlayAbove.js'

const HISTORY_LIMIT = 50

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
  /** Double-tap Esc with an empty input: open the session tree (pi parity). */
  onRewindRequest?(): void
  /** Filled with the live controller each render (see PromptController). */
  controllerRef?: React.RefObject<PromptController | null>
}

/**
 * Claude Code style prompt input: rounded border box (top+bottom borders
 * only), `❯ ` prompt char (dimmed while a turn is working), the text with a
 * block cursor at the cursor position, and below it the slash-command
 * suggestion overlay (name column + description, selected row in the
 * `suggestion` color — mirroring Claude Code's PromptInputFooterSuggestions).
 *
 * Empty input: a solid block caret on a blank cell and nothing else — no
 * placeholder text, so the terminal-painted IME preedit (pinyin) at the
 * parked cursor can never be overlaid on anything.
 *
 * Multi-line: Shift+Enter inserts a newline; ↑/↓ move between lines while
 * the input spans multiple lines (history/command selection otherwise); the
 * visible window scrolls to keep the caret row on screen past
 * MAX_VISIBLE_LINES. Enter submits, backspace/delete edit, ←/→ move the
 * cursor, Tab completes the selected command, Ctrl+X opens the draft in the
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
  const [value, setValue] = React.useState('')
  const [cursor, setCursor] = React.useState(0)
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
  // ctrl+r history fill: replace the input when a new fill arrives, then
  // tell the caller to clear it.
  const lastFill = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (fillText && fillText !== lastFill.current) {
      lastFill.current = fillText
      valueRef.current = fillText
      cursorRef.current = fillText.length
      setValue(fillText)
      setCursor(fillText.length)
      onFillConsumed?.()
    }
  }, [fillText, onFillConsumed])
  // Double-tap Esc to clear (CC semantics).
  const escPendingRef = React.useRef(false)
  const escTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  /** True while a Ctrl+V clipboard read is in flight (ignore repeat keys). */
  const clipboardBusyRef = React.useRef(false)
  /** True while the external editor owns the terminal (Ctrl+X round-trip). */
  const editorBusyRef = React.useRef(false)
  /** Enter dedupe window: cmd pipelines can deliver one Enter as `\r`+`\n`. */
  const lastEnterAtRef = React.useRef(0)
  React.useEffect(() => {
    return () => {
      if (escTimerRef.current) clearTimeout(escTimerRef.current)
    }
  }, [])
  const { columns, rows: terminalRows } = useTerminalSize()

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
  const [fileList, setFileList] = React.useState<readonly string[]>([])
  const [fileSelected, setFileSelected] = React.useState(0)
  const mention = mentionAtCaret(value, cursor)
  const atTrigger = mention !== undefined
  React.useEffect(() => {
    if (atTrigger) {
      void channel.listFiles().then(setFileList)
    }
  }, [atTrigger, channel])
  const atRest = (mention?.query ?? '').toLowerCase()
  // Match the relative path prefix OR the basename (CC's IDE suggestions do
  // both): `@src/ink` and `@ink` both find `src/ink/Box.js`.
  const fileMatches = atTrigger
    ? fileList.filter(file => {
        const lower = file.toLowerCase()
        if (lower.startsWith(atRest)) return true
        if (atRest.includes('/')) return false
        const base = lower.split('/').pop() ?? ''
        return base.startsWith(atRest)
      })
    : []
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

  const setInput = (next: string, cursorOffset = next.length) => {
    valueRef.current = next
    cursorRef.current = Math.max(0, Math.min(cursorOffset, next.length))
    setValue(next)
    setCursor(cursorRef.current)
  }

  /**
   * Accept the selected file suggestion: replace ONLY the mention token at
   * the caret (prefix/suffix text survives), quoting whitespace paths. A
   * directory inserts `@dir/` without a trailing space so completion
   * continues into it; a file completes the token with a space.
   */
  const acceptFile = (file: string) => {
    if (!mention) return
    const body = /\s/.test(file) ? `@"${file}"` : `@${file}`
    const insert = file.endsWith('/') ? body : `${body} `
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
   * Execute a slash command (built-in or plugin-registered) when the input
   * resolves to one: the name parses as the first token so `/plan off`
   * dispatches `plan` with its argument text, and the merged command list
   * (locals + registry) decides whether the line is a command at all.
   */
  const tryRunCommand = (text: string): boolean => {
    if (!text.startsWith('/')) return false
    const parsed = parseCommandName(text)
    if (parsed === undefined) return false
    const known = channel.commandList.some(command => command.name === parsed.name)
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
   * typing while PowerShell owns the clipboard never gets overwritten. */
  const insertClipboardAtCaret = (text: string) => {
    const current = valueRef.current
    const position = cursorRef.current
    setInput(current.slice(0, position) + text + current.slice(position), position + text.length)
    setSelectedCommand(0)
    setFileSelected(0)
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
      insertAtCaret(input.replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
      return
    }

    // Ctrl+V / Cmd+V: raw mode hands the key to the app, so the clipboard is
    // read here — text, file paths when the file manager copied files, or an
    // exported temp-file path when the clipboard holds a raw image.
    if (isMod(key) && input === 'v') {
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
          insertClipboardAtCaret(text)
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

    // Ctrl+X / Cmd+X: edit the current draft in $VISUAL/$EDITOR (issue #123,
    // readline's edit-and-execute-command). The draft is written to a temp
    // file, the terminal is handed to the editor (Ink's alt-screen handoff),
    // and the saved text replaces the input when it differs. The util maps
    // every failure to an outcome, but the catch/finally here is the hard
    // guarantee: a rejected promise must never kill the process, and the
    // busy flag must always clear or Ctrl+X stays locked forever.
    if (isMod(key) && input === 'x') {
      editorBusyRef.current = true
      void (async () => {
        try {
          const outcome = await editInExternalEditor(value)
          if (outcome.kind === 'edited') {
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
        // the side question never interrupts the running turn. Every other
        // input keeps the steer behavior so /new /model etc. stay idle-only.
        const parsed = value.startsWith('/') ? parseCommandName(value) : undefined
        if (parsed?.name === 'btw' && channel.commandList.some(c => c.name === 'btw')) {
          tryRunCommand(value)
          return
        }
        steerSend(value)
        return
      }
      if (!tryRunCommand(value)) submitText(value)
    }

    // Whole-line input from Windows ConPTY pipelines (cmd batch -> node):
    // the trailing CR/LF marks a complete line to submit. A bare Enter
    // arrives as `\r`/`\n`/`\r\n` — treat it as Enter, NOT a direct
    // submit. Only real multi-char piped lines keep the legacy
    // direct-submit path.
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
      if (command) setInput(command.replacement)
      return
    }
    // Tab while the model is working = queue for AFTER the turn (followup),
    // distinct from Enter's steer (Codex's "tab to queue message").
    if (key.tab && channel.working && value.trim() !== '') {
      queueSend(value)
      return
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
      historyIndex.current = historyIndex.current < 0
        ? history.current.length - 1
        : Math.max(0, historyIndex.current - 1)
      const entry = history.current[historyIndex.current] ?? ''
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
      historyIndex.current += 1
      const entry = historyIndex.current >= history.current.length
        ? ''
        : (history.current[historyIndex.current] ?? '')
      setInput(entry)
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
      setInput(value, Math.max(0, cursor - 1))
      return
    }
    if (key.rightArrow) {
      setInput(value, Math.min(value.length, cursor + 1))
      return
    }
    if (key.backspace) {
      if (cursor === 0) return
      setInput(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1)
      return
    }
    if (key.delete) {
      if (cursor >= value.length) return
      setInput(value.slice(0, cursor) + value.slice(cursor + 1), cursor)
      return
    }
    if (key.home) {
      // Start of the current line.
      const lineStart = value.lastIndexOf('\n', cursor - 1) + 1
      setInput(value, lineStart)
      return
    }
    if (key.end) {
      // End of the current line.
      const nextLine = value.indexOf('\n', cursor)
      setInput(value, nextLine === -1 ? value.length : nextLine)
      return
    }
    if (isMod(key) && input === 'a') {
      const lineStart = value.lastIndexOf('\n', cursor - 1) + 1
      setInput(value, lineStart)
      return
    }
    if (isMod(key) && input === 'e') {
      const nextLine = value.indexOf('\n', cursor)
      setInput(value, nextLine === -1 ? value.length : nextLine)
      return
    }
    if (isMod(key) && input === 'u') {
      // Delete to start of line.
      const lineStart = value.lastIndexOf('\n', cursor - 1) + 1
      setInput(value.slice(0, lineStart) + value.slice(cursor), lineStart)
      return
    }
    if (isMod(key) && input === 'k') {
      // Delete to end of line.
      const nextLine = value.indexOf('\n', cursor)
      const end = nextLine === -1 ? value.length : nextLine
      setInput(value.slice(0, cursor) + value.slice(end), cursor)
      return
    }
    if (isMod(key) && input === 'w') {
      // Delete the word before the cursor (CC/readline behavior): skip
      // trailing whitespace, then the whitespace-delimited word.
      const before = value.slice(0, cursor)
      let end = before.length
      while (end > 0 && /\s/.test(before[end - 1]!)) end--
      let start = end
      while (start > 0 && !/\s/.test(before[start - 1]!)) start--
      setInput(value.slice(0, start) + value.slice(cursor), start)
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
      // path below handles tree/clear on an already-empty input.
      if (value.length > 0) {
        setInput('', 0)
        setSelectedCommand(0)
        setFileSelected(0)
        return
      }
      // Double-tap Esc: clear the input when it has content; when empty,
      // open the session tree (pi's Session Tree — the family-wide rewind
      // panel, this project's take on CC's "double-tap esc to rewind").
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
        value.length === 0
          ? 'Press Esc again for the session tree'
          : 'Press Esc again to clear',
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
  const inputWidth = Math.max(10, columns - 3)
  const visualLines = wrapToWidth(value, inputWidth)
  const caretVisualLine = wrapToWidth(value.slice(0, cursor), inputWidth).length - 1
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
    const before = value.slice(0, cursor)
    const rows = wrapToWidth(before, inputWidth)
    const last = rows[rows.length - 1] ?? ''
    return last.length
  }
  const caretVisualCol = () => {
    const before = value.slice(0, cursor)
    const rows = wrapToWidth(before, inputWidth)
    const last = rows[rows.length - 1] ?? ''
    return stringWidth(last)
  }

  const rendered = visibleLines.map((line, index) => {
    const absoluteLine = windowStart + index
    if (absoluteLine !== caretVisualLine) {
      return (
        <Text key={absoluteLine} wrap="truncate-end">
          {line}
        </Text>
      )
    }
    // Caret row: invert the char at the caret column (solid block).
    const col = caretCharCol()
    const before = line.slice(0, col)
    const at = line[col] ?? ' '
    const after = line.slice(col + 1)
    return (
      <Text key={absoluteLine} wrap="truncate-end">
        {before}
        <Text inverse>{at}</Text>
        {after}
      </Text>
    )
  })

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
    column: caretVisualCol(),
    active: !selectionActive,
  })

  // 浮层整体挂载条件：与内部面板可见条件精确同值。关闭时必须把整个
  // absolute 浮层移除——渲染器的 absolute-removed 检测只看被移除节点自身
  // 的 style.position，常驻浮层 + 移除普通子节点不会触发 blit 解毒，被
  // 覆盖的转录行会留空（见 Chat.tsx dialogOverlayOpen 注释）。
  const floatersOpen = helpOpen || channel.pending.length > 0 || fileOverlayOpen || overlayOpen

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* 瞬态面板浮层（帮助/队列/补全）：零布局高度、向上覆盖转录尾部，
          帧高不随面板开关涨落——否则帧顶行会被滚进 scrollback 并在关闭
          重绘时二次写入（/model 切换多一份启动画的根因，见 OverlayAbove）。 */}
      {floatersOpen && (
      <OverlayAbove maxHeight={Math.max(terminalRows - 6, 4)}>
        {helpOpen && (
          <Box marginBottom={1}>
            <HelpMenu commands={channel.commandList} />
          </Box>
        )}
        {channel.pending.length > 0 && (
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
          <Box paddingLeft={2} paddingBottom={1}>
            <FileSuggestions
              files={fileMatches}
              selectedIndex={fileSelected}
              columns={columns}
            />
          </Box>
        )}
        {overlayOpen && (
          <Box paddingLeft={2} paddingBottom={1}>
            <CommandSuggestions
              commands={suggestions}
              selectedIndex={selectedCommand}
              columns={columns}
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
      <Box
        flexDirection="column"
        alignItems="flex-start"
        justifyContent="flex-start"
        borderColor={channel.mode.plan === true ? 'planMode' : 'promptBorder'}
        borderStyle="round"
        borderLeft={false}
        borderRight={false}
        borderBottom
        width="100%"
      >
        <Box flexDirection="row" alignItems="flex-start" width="100%">
          <Text dimColor={channel.working}>❯ </Text>
          <Box ref={valueBoxRef} flexGrow={1} flexShrink={1}>
            {value.length === 0 ? (
              // Solid block caret on a BLANK cell: the terminal paints the
              // IME preedit (pinyin) at the physical cursor, which is parked
              // right here, so nothing else may occupy this cell.
              <Text inverse> </Text>
            ) : (
              <Box flexDirection="column">{rendered}</Box>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

/**
 * Hard-wrap text into visual rows of at most `width` columns (CJK-aware via
 * stringWidth). Used by the input renderer so long lines wrap instead of
 * truncating, with exact caret-row mapping.
 */
function wrapToWidth(text: string, width: number): string[] {
  const rows: string[] = []
  for (const line of text.split('\n')) {
    if (line === '') {
      rows.push('')
      continue
    }
    let current = ''
    let currentWidth = 0
    for (const ch of line) {
      const w = stringWidth(ch)
      if (currentWidth + w > width && current !== '') {
        rows.push(current)
        current = ch
        currentWidth = w
      } else {
        current += ch
        currentWidth += w
      }
    }
    rows.push(current)
  }
  return rows
}
