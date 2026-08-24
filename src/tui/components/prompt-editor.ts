/**
 * Prompt editor for the chat screen (plan §1.3, WP-03): the vendored pi-tui
 * `Editor` with dsh-specific key dispatch at the current TUI boundary.
 *
 * The editor already carries the editing core — bracketed paste (reassembled
 * by `StdinBuffer` into one `\x1b[200~…\x1b[201~` event), large-paste
 * markers, kill ring, undo, word/line cursor motion, Ctrl+J / Shift+Enter /
 * Option+Enter newline insertion, up/down history with draft preservation
 * and the autocomplete plumbing — so this subclass only adds the dsh prompt
 * contract:
 *
 * - Enter routing: idle → `onSubmit` (the chat screen decides plain submit
 *   vs slash command), working → `onSteer`; Tab while working → `onQueue`;
 *   Ctrl+Enter → `onInterruptAndDeliver`; Alt+Up → `onPullBack`.
 * - Esc: closes the completion menu first; while working → `onCancel`;
 *   with text → clear; on an empty input the double-tap (3s window, timer
 *   owned here) → `onRewindRequest`.
 * - Ctrl+C: with text → clear + `onClearOrExit`; empty while working →
 *   `onCancel`; empty while idle → `onExitRequest` (single event per press —
 *   the double-press exit timing lives in the chat screen).
 * - Ctrl+G → `onOpenExternalEditor(expandedText)`; Ctrl+V reads the
 *   clipboard here (image → `commands.query.stageImage` → token insert,
 *   files/text → formatted insert), because the terminal hands raw-mode
 *   Ctrl+V to the app instead of pasting.
 * - Windows ConPTY whole-line delivery: a multi-char input containing CR/LF
 *   is a completed line to route, not text to insert.
 *
 * History is the Editor's in-memory list (`addToHistory` on every accepted
 * dispatch) plus the persisted JSONL log (`appendHistory`). Slash (`/`) and
 * file-mention (`@`) completion come from `PromptAutocompleteProvider`,
 * backed by `commands.query.commandCompletions` (sync) and the structured
 * `commands.query.listFileCandidates` sink (path-shaped queries list that
 * directory only, plain fragments rank the fuzzy session index).
 *
 * The component never touches the Channel/cordis/Agent/stdio: state arrives
 * via `update(PromptProjection)`, side effects leave through `TuiCommands`
 * and the callbacks above. Keyboard matching goes through
 * `matchesKey`/`Key` (never literal `data === 'x'`).
 */
import { readFile, unlink } from 'node:fs/promises'
import { basename } from 'node:path'
import chalk from 'chalk'
import {
  Editor,
  Key,
  isKeyRelease,
  matchesKey,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type EditorOptions,
  type EditorTheme,
  type TUI,
} from '../public.js'
import type { TuiCommands } from '../commands.js'
import type { PromptProjection } from '../view-model.js'
import { localizedDescription } from '../../commands.js'
import { appendHistory } from '../../history.js'
import { t } from '../../i18n.js'
import {
  formatClipboardInsert,
  readClipboard,
  type ClipboardContent,
} from '../../utils/clipboard.js'
import { mentionAtCaret } from '../../utils/mentions.js'
import type { FileCandidateKind } from '../../utils/fileSuggestions.js'
import { getActiveTheme } from '../../theme.js'
import { parseRGB } from '../../components/Spinner/spinnerUtils.js'

type StagedImageInput = Parameters<TuiCommands['query']['stageImage']>[0]
type ImageMediaType = StagedImageInput['mediaType']

/** One Enter can arrive twice from cmd pipelines (`\r` then a raw `\n`). */
const ENTER_DEDUPE_MS = 80
/** Double-tap Esc window for the rewind request (CC semantics). */
const ESC_DOUBLE_TAP_MS = 3000
/** Cap on the `@` file-mention suggestion list (the menu shows 5 anyway). */
const FILE_COMPLETION_LIMIT = 50

/** File-mention completion item: the candidate's `kind` rides along so the
 *  accept path distinguishes file/directory by data, not by a trailing-`/`
 *  guess. The id contract stays `value === candidate.path`. */
type FileSuggestionItem = AutocompleteItem & { kind?: FileCandidateKind }

// Kitty CSI-u sequence: ESC [ keycode ; modifier[:eventType] u. Only the
// simple two-field form is matched — enough to rewrite `ctrl+<LETTER>` with
// caps_lock into its unlocked form (ported from Kimi's custom-editor: pi's
// matcher masks caps_lock out of the modifier but leaves the codepoint
// capitalized, silently dropping every ctrl-letter shortcut).
// oxlint-disable-next-line no-control-regex -- ESC is required to match CSI
const KITTY_CSI_U = /^\u001B\[(\d+);(\d+)((?::\d+)*)u$/
const CAPS_LOCK_BIT = 64
const CTRL_BIT = 4
const SHIFT_BIT = 1

function normalizeCapsLockedCtrl(data: string): string {
  const m = data.match(KITTY_CSI_U)
  if (m === null) return data
  const codepoint = Number(m[1])
  const modifierPlus1 = Number(m[2])
  const tail = m[3] ?? ''
  if (!Number.isFinite(codepoint) || !Number.isFinite(modifierPlus1)) return data
  const modifier = modifierPlus1 - 1
  if ((modifier & CAPS_LOCK_BIT) === 0) return data
  if ((modifier & CTRL_BIT) === 0) return data
  if ((modifier & SHIFT_BIT) !== 0) return data
  if (codepoint < 65 || codepoint > 90) return data
  const strippedModifier = (modifier & ~CAPS_LOCK_BIT) + 1
  return `\u001B[${String(codepoint + 32)};${String(strippedModifier)}${tail}u`
}

function clipboardImageMediaType(path: string): ImageMediaType | undefined {
  if (/\.png$/iu.test(path)) return 'image/png'
  if (/\.jpe?g$/iu.test(path)) return 'image/jpeg'
  if (/\.webp$/iu.test(path)) return 'image/webp'
  if (/\.gif$/iu.test(path)) return 'image/gif'
  return undefined
}

/** Paint with a theme `rgb(r,g,b)` value; identity when unparsable. */
function themePainter(color: string | undefined): (text: string) => string {
  const rgb = color === undefined ? null : parseRGB(color)
  if (rgb === null) return (text) => text
  return (text) => chalk.rgb(rgb.r, rgb.g, rgb.b)(text)
}

/**
 * Build the Editor theme (border + completion-menu colors) from the active
 * dsh theme. The chat screen may still reassign `editor.borderColor` for
 * transient states; `update()` re-applies the plan-mode accent.
 */
export function createPromptEditorTheme(): EditorTheme {
  const theme = getActiveTheme()
  const selected = themePainter(theme.suggestion)
  const dim = (text: string): string => chalk.dim(text)
  return {
    borderColor: themePainter(theme.promptBorder),
    selectList: {
      selectedPrefix: (text) => selected(text),
      selectedText: (text) => selected(text),
      description: (text) => dim(text),
      scrollInfo: (text) => dim(text),
      noMatch: (text) => dim(text),
    },
  }
}

/**
 * Slash-command and `@` file-mention completion over the command sink.
 * Slash completions are synchronous (`commandCompletions` is pure over the
 * command registry); file suggestions go through the typed
 * `listFileCandidates` query — structured candidates with a stable id and a
 * file/directory kind, ranked channel-side. Stale results never land: the
 * sink's sessionEpoch/generation fence drops them as `undefined`, the
 * channel honors the per-request `signal`, and the Editor additionally
 * guards by request id + text/cursor snapshot before applying anything.
 * Selection across async refreshes is the Editor's own best-match rule over
 * a deterministically ranked list; the compatibility item shape keeps the
 * basename/displayPath labels while carrying the candidate kind for accept.
 *
 * Exported for the node:test surface (test/tui/file-candidates.test.ts).
 */
export class PromptAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters = ['@']

  constructor(private readonly commands: TuiCommands) {}

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const line = lines[cursorLine] ?? ''
    const before = line.slice(0, cursorCol)

    // Slash commands: first line only, leading '/' (Editor gates the trigger).
    if (cursorLine === 0 && before.startsWith('/')) {
      const completions = this.commands.query.commandCompletions(before)
      if (completions.length === 0) return null
      return {
        prefix: before,
        items: completions.map((completion): AutocompleteItem => {
          // Localize at render time (a /lang switch repaints the next menu)
          // and fold the [current]/[default]/aliases tag into the description
          // column — the pi-tui item shape has no tag slot of its own.
          const description = localizedDescription(completion)
          const tag = completion.tag === undefined ? '' : `[${completion.tag}]`
          const text = tag === '' ? description : description === '' ? tag : `${description} ${tag}`
          return {
            value: completion.commandLine,
            label: completion.commandLine,
            ...(text === '' ? {} : { description: text }),
          }
        }),
      }
    }

    // `@` file mention at the caret: the trigger is the token being edited,
    // so `@` works mid-message, not only as the first character. The query is
    // the token fragment as typed; the channel ranks path-shaped queries
    // against that directory and plain fragments against the session pool.
    const mention = mentionAtCaret(line, cursorCol)
    if (mention === undefined) return null
    const candidates = await this.commands.query.listFileCandidates(mention.query, {
      signal: options.signal,
      topK: FILE_COMPLETION_LIMIT,
    })
    if (candidates === undefined || options.signal.aborted || candidates.length === 0) return null
    return {
      prefix: line.slice(mention.start, cursorCol),
      items: candidates.map((candidate): FileSuggestionItem => {
        // Keep the established pi display contract (basename + displayPath)
        // while carrying the structured kind for the accept path. The metadata
        // is non-enumerable so older integrations comparing the item shape keep
        // working; `applyCompletion` still reads it when present.
        const item = {
          value: candidate.path,
          label: candidate.kind === 'directory' ? `${candidate.name}/` : candidate.name,
          description: candidate.displayPath,
        } as FileSuggestionItem
        Object.defineProperty(item, 'kind', {
          value: candidate.kind,
          enumerable: false,
          configurable: true,
        })
        return item
      }),
    }
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const line = lines[cursorLine] ?? ''
    const nextLines = [...lines]

    if (prefix.startsWith('/')) {
      // Replace the whole slash text before the cursor with the completed
      // command line plus a trailing space, preserving the completion contract.
      const after = line.slice(cursorCol).replace(/^ /, '')
      const completed = `${item.value} `
      nextLines[cursorLine] = completed + after
      return { lines: nextLines, cursorLine, cursorCol: completed.length }
    }

    // `@` mention: replace ONLY the token at the caret, quoting paths with
    // whitespace; a directory (by candidate kind, falling back to the
    // compatible trailing-`/` label or value contract) inserts `@dir/`
    // without a trailing space so completion continues into it.
    const mention = mentionAtCaret(line, cursorCol)
    if (mention === undefined) {
      return { lines, cursorLine, cursorCol }
    }
    const isDirectory = (item as FileSuggestionItem).kind === 'directory'
      || item.label?.endsWith('/') === true
      || item.value.endsWith('/')
    const body = /\s/.test(item.value) ? `@"${item.value}"` : `@${item.value}`
    const insert = isDirectory ? body : `${body} `
    nextLines[cursorLine] = line.slice(0, mention.start) + insert + line.slice(mention.end)
    return { lines: nextLines, cursorLine, cursorCol: mention.start + insert.length }
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    // Tab forces completion only inside an `@` mention; plain text never
    // triggers free path completion.
    return mentionAtCaret(lines[cursorLine] ?? '', cursorCol) !== undefined
  }
}

export class PromptEditor extends Editor {
  /** Enter while idle — the chat screen decides plain submit vs slash command. */
  onSubmitPrompt?: (text: string) => void
  /** Enter while a turn is working (steer into the running turn). */
  onSteer?: (text: string) => void
  /** Tab while working (queue as followup for after the turn). */
  onQueue?: (text: string) => void
  /** Ctrl+Enter: abort the running turn and deliver immediately. */
  onInterruptAndDeliver?: (text: string) => void
  /** Esc or Ctrl+C while working — the chat screen calls `commands.input.cancel`. */
  onCancel?: () => void
  /** Alt+Up: pull the last pending message back for re-editing. */
  onPullBack?: () => void
  /** Double-tap Esc on an empty input (CC rewind). The 3s timer is owned here. */
  onRewindRequest?: () => void
  /** Ctrl+C on an empty input — one event per press; the double-press exit
   *  timing lives in the chat screen. */
  onExitRequest?: () => void
  /** Ctrl+G: edit the draft in $VISUAL/$EDITOR (expanded = paste markers resolved). */
  onOpenExternalEditor?: (text: string) => void
  /** Ctrl+C with text in the editor (the editor has already cleared it). */
  onClearOrExit?: () => void
  /** A clipboard image was staged and its token inserted. */
  onImagePaste?: (token: string) => void

  private commands: TuiCommands
  private vm: PromptProjection
  private escPending = false
  private escTimer: ReturnType<typeof setTimeout> | null = null
  private clipboardBusy = false
  private lastEnterAt = 0

  constructor(
    ui: TUI,
    commands: TuiCommands,
    vm: PromptProjection,
    theme: EditorTheme = createPromptEditorTheme(),
    options: EditorOptions = {},
  ) {
    super(ui, theme, options)
    this.commands = commands
    this.vm = vm
    this.setAutocompleteProvider(new PromptAutocompleteProvider(commands))
    this.applyModeBorder()
  }

  /** Feed the latest prompt projection (working/mode drive the key routing). */
  update(vm: PromptProjection): void {
    this.vm = vm
    this.applyModeBorder()
    this.invalidate()
    this.tui.requestRender()
  }

  /** Release the double-tap Esc timer. */
  dispose(): void {
    if (this.escTimer !== null) {
      clearTimeout(this.escTimer)
      this.escTimer = null
    }
    this.escPending = false
  }

  /**
   * Paste the system clipboard into the prompt outside the keyboard path —
   * the TuiAltScreen `onRightClickPaste` hook (Windows) lands here. Same
   * async read + busy-guard as Ctrl+V (`pasteFromClipboard`).
   */
  requestClipboardPaste(): void {
    this.pasteFromClipboard()
  }

  override handleInput(data: string): void {
    const normalized = normalizeCapsLockedCtrl(data)
    if (isKeyRelease(normalized)) return

    // Bracketed paste arrives as one complete re-wrapped event (StdinBuffer
    // reassembles it) — straight to the Editor's paste handling.
    if (normalized.includes('\x1b[200~')) {
      super.handleInput(normalized)
      return
    }

    // Windows ConPTY pipelines deliver whole lines with the Enter key folded
    // in: a multi-char input containing CR/LF completes the line instead of
    // inserting text. A bare CR/LF run is just Enter (possibly doubled).
    if (normalized.length > 1 && !normalized.includes('\x1b') && /[\r\n]/.test(normalized)) {
      if (/^[\r\n]+$/.test(normalized)) {
        this.dispatchSubmit()
      } else {
        this.dispatchPipedLine(normalized)
      }
      return
    }

    // Ctrl+C must run before super: the Editor swallows it as `tui.input.copy`.
    // Priority: text → clear; empty + working → cancel; empty + idle → exit
    // request (the chat screen arms the double-press window).
    if (matchesKey(normalized, Key.ctrl('c'))) {
      if (this.getText() !== '') {
        this.clearAfterSend()
        this.onClearOrExit?.()
        return
      }
      if (this.vm.working) {
        this.onCancel?.()
        return
      }
      this.onExitRequest?.()
      return
    }

    if (matchesKey(normalized, Key.ctrl('v'))) {
      this.pasteFromClipboard()
      return
    }

    if (matchesKey(normalized, Key.ctrl('g'))) {
      this.onOpenExternalEditor?.(this.getExpandedText())
      return
    }

    if (matchesKey(normalized, Key.ctrl('enter'))) {
      this.dispatchInterruptAndDeliver()
      return
    }

    if (matchesKey(normalized, Key.alt('up'))) {
      this.onPullBack?.()
      return
    }

    if (matchesKey(normalized, Key.escape)) {
      this.handleEscape(normalized)
      return
    }

    // Tab while working with text = queue for after the turn — but the open
    // completion menu owns Tab first (accept the selection), as before.
    if (matchesKey(normalized, Key.tab) && !this.isShowingAutocomplete()) {
      if (this.vm.working && this.getText().trim() !== '') {
        const text = this.getExpandedText().trim()
        this.recordHistory(text)
        this.clearAfterSend()
        this.onQueue?.(text)
        return
      }
      super.handleInput(normalized)
      return
    }

    // Bare LF is Ctrl+J (newline), never Enter — exclude it explicitly so the
    // portable-multiline fallback survives the `matchesKey(enter)` mapping of
    // `\n` when the Kitty protocol is inactive.
    if (normalized !== '\n' && matchesKey(normalized, Key.enter)) {
      this.handleEnter(normalized)
      return
    }

    super.handleInput(normalized)
  }

  /**
   * Enter dispatch. With the completion menu open the menu owns Enter: `@`
   * items are accepted without submitting, while a slash item is accepted AND
   * submitted in one keypress (the pi-tui completion contract — applied via a
   * synthetic Tab so the dispatch below still records history and routes by
   * working state). Without the menu, the `\`-before-cursor newline workaround
   * for terminals without Shift+Enter stays with the Editor.
   */
  private handleEnter(data: string): void {
    if (this.isShowingAutocomplete()) {
      const { line, col } = this.getCursor()
      const before = (this.getLines()[line] ?? '').slice(0, col)
      if (line === 0 && before.trimStart().startsWith('/')) {
        super.handleInput('\t')
        this.dispatchSubmit()
      } else {
        super.handleInput(data)
      }
      return
    }
    const { line, col } = this.getCursor()
    const currentLine = this.getLines()[line] ?? ''
    if (col > 0 && currentLine[col - 1] === '\\') {
      super.handleInput(data)
      return
    }
    this.dispatchSubmit()
  }

  /** Enter/queued send shared by the typed and piped-line paths. */
  private dispatchSubmit(): void {
    const text = this.getExpandedText().trim()
    if (text === '') return
    const now = Date.now()
    if (now - this.lastEnterAt < ENTER_DEDUPE_MS) return
    this.lastEnterAt = now
    this.recordHistory(text)
    this.clearAfterSend()
    if (this.vm.working) {
      this.onSteer?.(text)
    } else {
      this.onSubmitPrompt?.(text)
    }
  }

  /** A piped line is `current text + input`, trimmed and routed like Enter. */
  private dispatchPipedLine(input: string): void {
    const text = (this.getExpandedText() + input).trim()
    if (text === '') return
    this.recordHistory(text)
    this.clearAfterSend()
    if (this.vm.working) {
      this.onSteer?.(text)
    } else {
      this.onSubmitPrompt?.(text)
    }
  }

  private dispatchInterruptAndDeliver(): void {
    const text = this.getExpandedText().trim()
    if (text === '') {
      this.commands.info.notify(t('input-empty'), { color: 'warning' })
      return
    }
    this.recordHistory(text)
    this.clearAfterSend()
    this.onInterruptAndDeliver?.(text)
  }

  private handleEscape(data: string): void {
    // A single Esc closes the open completion menu first (CC/pi behavior).
    if (this.isShowingAutocomplete()) {
      super.handleInput(data)
      return
    }
    // While working, Esc interrupts (the chat screen decides plain cancel vs
    // interrupt-and-deliver of the queued messages).
    if (this.vm.working) {
      this.onCancel?.()
      return
    }
    // A single Esc clears a non-empty input.
    if (this.getText() !== '') {
      this.clearAfterSend()
      return
    }
    // Empty input: the second tap inside the window asks for the rewind picker.
    if (this.escPending) {
      this.escPending = false
      if (this.escTimer !== null) {
        clearTimeout(this.escTimer)
        this.escTimer = null
      }
      this.onRewindRequest?.()
      return
    }
    this.escPending = true
    this.commands.info.notify(t('esc-again-rewind'))
    this.escTimer = setTimeout(() => {
      this.escPending = false
      this.escTimer = null
    }, ESC_DOUBLE_TAP_MS)
    this.escTimer.unref?.()
  }

  /**
   * Ctrl+V: raw mode hands the key to the app, so the clipboard is read
   * here — an image is staged via the command sink and its token inserted;
   * files/text insert formatted. The read is async and the insert lands at
   * the LIVE cursor, so typing while the read is in flight is safe.
   */
  private pasteFromClipboard(): void {
    if (this.clipboardBusy) return
    this.clipboardBusy = true
    void readClipboard()
      .then(async (content) => {
        if (content === null) {
          this.commands.info.notify(t('input-clipboard-empty'), { color: 'warning' })
          return
        }
        if (content.kind === 'unavailable') {
          this.commands.info.notify(t('input-clipboard-unavailable'), { color: 'warning' })
          return
        }
        if (content.kind === 'image') {
          const mediaType = clipboardImageMediaType(content.path)
          if (mediaType !== undefined) {
            try {
              const token = await this.commands.query.stageImage({
                data: new Uint8Array(await readFile(content.path)),
                mediaType,
                name: basename(content.path),
              })
              // The staged-image map is session-scoped: a fenced sink returns
              // undefined when the session moved on — drop the insert.
              if (token !== undefined) {
                await unlink(content.path).catch(() => undefined)
                this.insertTextAtCursor(`${token} `)
                this.commands.info.notify(t('input-image-pasted', { token }), { timeoutMs: 2500 })
                this.onImagePaste?.(token)
                return
              }
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error)
              this.commands.info.notify(t('input-image-paste-failed', { err: message }), {
                color: 'warning',
                timeoutMs: 5000,
              })
            }
          }
        }
        this.insertTextAtCursor(formatClipboardInsert(content as ClipboardContent))
      })
      .catch(() => {
        this.commands.info.notify(t('input-clipboard-read-failed'), { color: 'warning' })
      })
      .finally(() => {
        // A rejected read must never wedge Ctrl+V for the rest of the session.
        this.clipboardBusy = false
      })
  }

  private recordHistory(text: string): void {
    this.addToHistory(text)
    appendHistory(text)
  }

  /**
   * Reset the editor after an accepted send. `setText('')` cancels the
   * completion menu, clears the paste registry and exits history browsing;
   * the one undo snapshot it pushes lets Ctrl+- right after a send restore the
   * sent draft.
   */
  private clearAfterSend(): void {
    this.setText('')
  }

  /** Plan-mode border accent, re-applied on every projection update. */
  private applyModeBorder(): void {
    const theme = getActiveTheme()
    this.borderColor = themePainter(this.vm.mode.plan === true ? theme.planMode : theme.promptBorder)
  }
}
