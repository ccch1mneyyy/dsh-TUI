/**
 * The managed plugin dialog (`ctx.tuiDialogs`) as an imperative pi-tui
 * component (plan §1.3, WP-03) — migrated from the retired React
 * `src/components/ExtensionDialog.tsx`. One view renders the dialog store's
 * current snapshot in the chat chrome (the slot the approval/question panels
 * occupy); the three kinds share the component:
 *
 * - `select`  — focus list (↑/↓, windowed around the focus), Enter settles
 *   the option id;
 * - `confirm` — two rows (confirm/cancel), Enter settles the boolean;
 * - `input`   — single-line text edit, Enter settles the text.
 *
 * Esc (and Ctrl+C) always cancels — the plugin's promise resolves with the
 * cancelled value. decide/cancel carry the snapshot `key` verbatim: the store
 * ignores a mismatched key, so a stale callback (e.g. ConPTY delivering one
 * Enter as a same-batch CR+LF pair) can never settle a successor dialog this
 * view never rendered. Only a modifier-free Enter commits
 * (`matchesKey(data, Key.enter)`: Option+Enter = ESC CR and Ctrl+Enter =
 * CSI 13;5u never match, see fork keys.ts); a bracketed paste is inserted as
 * text, never submitted.
 *
 * The input branch enforces the protocol's documented answer bound
 * (INPUT_CELLS in src/dsh-adapter/dialogs.ts) on every edit path — typing
 * past the cap is ignored, an oversized paste is truncated — so the plugin's
 * promise never resolves with a larger value. Cursor steps count code points,
 * so an emoji can never be split into a lone surrogate.
 *
 * Contract: the chat screen pushes the store snapshot via {@link update}
 * (null hides the view — zero rows) and routes the keyboard to
 * {@link handleInput} while pending. A new snapshot `key` remounts the view
 * state (fresh focus, input reseeded from `initial`), mirroring the old React
 * `key={dialog.key}` remount. Pointer: a primary-button click on a
 * select/confirm row settles it like Enter (the retired React panel's
 * onClick; the input row has no click action) — see {@link handlePointer}.
 */
import { t } from '../../../i18n.js'
import { POINTER } from '../../../cc/figures.js'
import { listWindow } from '../../../components/listWindow.js'
import type { TuiDialogSnapshot } from '../../../dsh-adapter/dialogs.js'
import { capCells, flattenInline } from '../../../dsh-adapter/sanitize.js'
import type { TuiCommands } from '../../commands.js'
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type PointerEvent, type TUI } from '../../public.js'
import { bold, dim, dividerLine, hintLine, inverse, LineEdit, textInput, themePainter } from './overlay-chrome.js'

/** Content left padding inside the Pane (the old Box paddingX={2}). */
const PAD = '  '

/** A clickable row span: [start, end) line offsets within the last render
 *  output, plus the option index it activates. */
interface RowSpan {
  readonly start: number
  readonly end: number
  readonly index: number
}

/**
 * The documented bound of the resolved input text. Mirrors INPUT_CELLS in
 * src/dsh-adapter/dialogs.ts — duplicated as a literal on purpose: that
 * module imports cordis, and overlay components must keep their runtime
 * import graph free of it (type-only imports stay).
 */
const INPUT_CELLS = 500

export class ExtensionDialogView implements Component {
  private snapshot: TuiDialogSnapshot | null = null
  /** The key of the snapshot the state below belongs to (remount marker). */
  private key: string | null = null
  private focusIndex = 0
  private readonly edit = new LineEdit()
  /** Click hit map recorded by the last render (view-local line offsets). */
  private rowSpans: RowSpan[] = []

  constructor(
    private readonly commands: TuiCommands,
    private readonly ui: TUI,
  ) {}

  /** Push the current dialog snapshot; null hides the view. */
  update(dialog: TuiDialogSnapshot | null): void {
    const key = dialog?.key ?? null
    if (key !== this.key) {
      this.key = key
      this.focusIndex = 0
      this.edit.reset(dialog?.kind === 'input' ? dialog.initial : '')
    }
    this.snapshot = dialog
    this.ui.requestRender()
  }

  invalidate(): void {
    // No cached state to invalidate (render recomputes from the snapshot).
  }

  // ── input ────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    const snapshot = this.snapshot
    if (snapshot === null) return

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.commands.overlays.cancelDialog(snapshot.key)
      return
    }

    switch (snapshot.kind) {
      case 'select':
        this.handleSelectInput(snapshot, data)
        break
      case 'confirm':
        this.handleConfirmInput(snapshot, data)
        break
      case 'input':
        this.handleTextInput(snapshot, data)
        break
    }
    this.ui.requestRender()
  }

  private handleSelectInput(
    snapshot: Extract<TuiDialogSnapshot, { kind: 'select' }>,
    data: string,
  ): void {
    if (matchesKey(data, Key.up)) { this.moveFocus(-1, snapshot.options.length); return }
    if (matchesKey(data, Key.down)) { this.moveFocus(1, snapshot.options.length); return }
    if (matchesKey(data, Key.enter)) {
      const option = snapshot.options[this.focusIndex]
      if (option !== undefined) this.commands.overlays.decideDialog(snapshot.key, option.id)
    }
  }

  private handleConfirmInput(
    snapshot: Extract<TuiDialogSnapshot, { kind: 'confirm' }>,
    data: string,
  ): void {
    if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) { this.moveFocus(-1, 2); return }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.right)) { this.moveFocus(1, 2); return }
    if (matchesKey(data, Key.enter)) {
      this.commands.overlays.decideDialog(snapshot.key, this.focusIndex === 0)
    }
  }

  private handleTextInput(
    snapshot: Extract<TuiDialogSnapshot, { kind: 'input' }>,
    data: string,
  ): void {
    if (matchesKey(data, Key.enter)) {
      this.commands.overlays.decideDialog(snapshot.key, this.edit.value)
      return
    }
    if (matchesKey(data, Key.backspace)) { this.edit.backspace(); return }
    if (matchesKey(data, Key.delete)) { this.edit.deleteForward(); return }
    if (matchesKey(data, Key.left)) { this.edit.moveLeft(); return }
    if (matchesKey(data, Key.right)) { this.edit.moveRight(); return }
    if (matchesKey(data, Key.home)) { this.edit.moveHome(); return }
    if (matchesKey(data, Key.end)) { this.edit.moveEnd(); return }

    // A bracketed paste arrives as one chunk and may carry newlines/control
    // chars — this is a single-line panel, so flatten them to spaces. Every
    // edit path holds the value at INPUT_CELLS cells so the resolved answer
    // keeps the documented bound: typing past the cap is ignored, an
    // oversized paste is truncated (never silently unbounded).
    const pasted = data.includes('\x1b[200~')
    const chunk = pasted
      ? flattenInline(data.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, ''))
      : textInput(data)
    if (chunk === undefined || chunk === '') return
    const at = this.edit.cursor
    const candidate = this.edit.previewInsert(chunk)
    if (visibleWidth(candidate) <= INPUT_CELLS) {
      this.edit.insert(chunk)
    } else if (pasted) {
      const capped = capCells(candidate, INPUT_CELLS)
      this.edit.reset(capped, Math.min(at + [...chunk].length, [...capped].length))
    }
  }

  private moveFocus(delta: 1 | -1, rowCount: number): void {
    if (rowCount <= 0) return
    this.focusIndex = (this.focusIndex + delta + rowCount) % rowCount
  }

  /**
   * Click parity with the retired React ExtensionDialog (research §4.3): a
   * primary-button click on a select row settles that option id, on a
   * confirm row settles the boolean — the keyboard equivalent of moving the
   * focus there and pressing Enter. The input row has no click action
   * (source has none either). Every event reaching this handler lies inside
   * the view rect and is consumed (blocking modal); blank cells and non-row
   * regions consume without acting.
   */
  handlePointer(event: PointerEvent): boolean | void {
    const snapshot = this.snapshot
    if (snapshot === null) return undefined
    if (event.type === 'click' && event.button === 0 && !event.cellIsBlank) {
      const hit = this.rowSpans.find(span => event.localY >= span.start && event.localY < span.end)
      if (hit !== undefined && snapshot.kind === 'select') {
        const option = snapshot.options[hit.index]
        if (option !== undefined) this.commands.overlays.decideDialog(snapshot.key, option.id)
      } else if (hit !== undefined && snapshot.kind === 'confirm') {
        this.commands.overlays.decideDialog(snapshot.key, hit.index === 0)
      }
    }
    return true
  }

  // ── render ───────────────────────────────────────────────────────────

  render(width: number): string[] {
    const snapshot = this.snapshot
    if (snapshot === null) return []
    this.rowSpans = []

    // The Pane chrome: a gap row, a full-width permission rule, then the
    // padded content column.
    const lines: string[] = ['', dividerLine(width, undefined, 'permission')]
    const remember = themePainter('remember')

    lines.push(PAD + remember(bold(snapshot.title)))
    if (snapshot.kind === 'confirm' && snapshot.message !== undefined) {
      for (const line of wrapTextWithAnsi(snapshot.message, Math.max(1, width - 4))) {
        lines.push(PAD + dim(line))
      }
    }
    lines.push('')

    switch (snapshot.kind) {
      case 'select':
        this.renderSelectRows(lines, snapshot, width)
        break
      case 'confirm':
        this.renderConfirmRows(lines, snapshot, width)
        break
      case 'input':
        this.renderTextRow(lines, snapshot, width)
        break
    }

    lines.push(PAD + hintLine(t(snapshot.kind === 'input' ? 'hint-ext-dialog-input' : 'hint-select-exit')))
    return lines
  }

  /**
   * The select rows, windowed around the focus so it stays visible on short
   * terminals: a described option costs two rows, a bare one one (the frame
   * reservation of ten rows mirrors the retired panel).
   */
  private renderSelectRows(
    lines: string[],
    snapshot: Extract<TuiDialogSnapshot, { kind: 'select' }>,
    width: number,
  ): void {
    const suggestion = themePainter('suggestion')
    const inactive = themePainter('inactive')
    const heights = snapshot.options.map(option => (option.description === undefined ? 1 : 2))
    const window_ = listWindow(heights, this.focusIndex, Math.max(this.ui.terminal.rows - 10, 2))
    const labelWidth = Math.max(1, width - 4)

    for (let index = window_.start; index < window_.end; index += 1) {
      const option = snapshot.options[index]!
      const focused = index === this.focusIndex
      const pointer = focused
        ? POINTER
        : index === window_.start && window_.start > 0
          ? '↑'
          : index === window_.end - 1 && window_.end < snapshot.options.length
            ? '↓'
            : ' '
      const pointerCell = pointer === ' ' ? ' ' : focused ? suggestion(pointer) : dim(pointer)
      const start = lines.length
      const label = truncateToWidth(option.label.replace(/[\r\n]+/g, ' '), labelWidth, '…')
      lines.push(`${PAD}${pointerCell} ${focused ? suggestion(label) : label}`)
      if (option.description !== undefined) {
        const description = truncateToWidth(option.description.replace(/[\r\n]+/g, ' '), labelWidth, '…')
        lines.push(`${PAD}  ${inactive(description)}`)
      }
      this.rowSpans.push({ start, end: lines.length, index })
    }
  }

  private renderConfirmRows(
    lines: string[],
    snapshot: Extract<TuiDialogSnapshot, { kind: 'confirm' }>,
    width: number,
  ): void {
    const suggestion = themePainter('suggestion')
    const labels = [
      snapshot.confirmLabel || t('ext-dialog-yes'),
      snapshot.cancelLabel || t('ext-dialog-no'),
    ]
    for (const [index, label] of labels.entries()) {
      const focused = index === this.focusIndex
      const pointerCell = focused ? suggestion(POINTER) : ' '
      const text = truncateToWidth(label.replace(/[\r\n]+/g, ' '), Math.max(1, width - 4), '…')
      const start = lines.length
      lines.push(`${PAD}${pointerCell} ${focused ? suggestion(text) : text}`)
      this.rowSpans.push({ start, end: lines.length, index })
    }
  }

  /** The input row: the value (or the dim placeholder) with the inverse cell
   *  under the cursor (CC's block cursor); at end of line it inverts the
   *  trailing space. Splits are code-point safe — the caret never lands
   *  inside a surrogate pair. */
  private renderTextRow(
    lines: string[],
    snapshot: Extract<TuiDialogSnapshot, { kind: 'input' }>,
    width: number,
  ): void {
    const shown = this.edit.value === '' && snapshot.placeholder !== undefined
      ? snapshot.placeholder
      : this.edit.value
    const shownPoints = [...shown]
    const before = shownPoints.slice(0, this.edit.cursor).join('')
    const at = shownPoints[this.edit.cursor] ?? ' '
    const after = shownPoints.slice(this.edit.cursor + 1).join('')
    const line = (this.edit.value === '' ? dim(before) : before) + inverse(at) + after
    for (const wrapped of wrapTextWithAnsi(line, Math.max(1, width - 2))) {
      lines.push(PAD + wrapped)
    }
  }
}
