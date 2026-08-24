/**
 * The questionnaire panel as an imperative pi-tui component (plan §1.3,
 * WP-03) — the Claude Code style ask-user-question UI for the DSH
 * user-interaction seam, migrated from the retired React
 * `src/components/questions/AskUserQuestionPanel.tsx` and
 * `PlanReviewPanel.tsx`.
 *
 * One question per panel: progress divider, optional header chip, wrapped
 * question text, optional detail, the option list (focus pointer, multi-select
 * checkmarks), and the trailing free-text input row — the list's last row IS
 * the input (issue #9): typing while focused on a real option appends into
 * that row (single-select also attaches the option's label, so the answer can
 * carry both `selected` and `custom`); focusing the input row itself and
 * typing gives a pure custom answer. `hideCustomInput` (local wizard
 * extension) hides that row for pure option questions and typing then inserts
 * nothing. `intent.kind === 'plan-review'` switches to the decision-card
 * layout (approve row + feedback row + digit quick-pick); an intent never
 * changes the protocol:
 *
 * - Approve: `{ selected: [intent.approve] }` — custom MUST be absent, or
 *   plan-mode reads it as keep-planning-with-feedback.
 * - Keep planning / feedback: `{ selected: [declineLabel], custom? }`.
 * - Esc / Ctrl+C: `commands.overlays.cancelQuestion()` (ASK_CANCELLED — the
 *   user dismissed the review to speak instead).
 *
 * Contract: the chat screen pushes the store snapshot via {@link update}
 * (null hides the panel — zero rows) and routes the keyboard to
 * {@link handleInput} while pending. A new snapshot `key` remounts the panel
 * state (fresh selection/focus/buffer), mirroring the old React
 * `key={snapshot.key}` remount. Only a modifier-free Enter submits
 * (`matchesKey(data, Key.enter)`: Option+Enter = ESC CR and Ctrl+Enter =
 * CSI 13;5u never match, see fork keys.ts). The input row emits
 * CURSOR_MARKER at the caret whenever visible (the old useDeclaredCursor
 * IME anchor) — typing on an option row also lands in this buffer, so the
 * anchor must follow even when the row itself is not focused.
 *
 * Pointer (research §4.3): a primary-button click reuses the keyboard
 * action of the clicked row — option rows answer/toggle/focus+submit per
 * kind, the input row focuses (never submits); everything inside the panel
 * rect is consumed — see {@link handlePointer}.
 */
import { t } from '../../../i18n.js'
import { POINTER } from '../../../cc/figures.js'
import { listWindow } from '../../../components/listWindow.js'
import type { QuestionSelection, QuestionSnapshot } from '../../../dsh-adapter/questions.js'
import type { TuiCommands } from '../../commands.js'
import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type PointerEvent,
  type TUI,
} from '../../public.js'
import { bold, dim, dividerLine, inverse, italic, LineEdit, textInput, themePainter } from './overlay-chrome.js'

const CHECKED = '◉'
const UNCHECKED = '○'
const SINGLE_SELECTED = '●'
const PENCIL = '✎'

/** Left padding of the panel body (the old Box paddingLeft={2}). */
const PAD = '  '
/** X offset where option labels / the input tail start (pointer + check + gap). */
const LABEL_PAD = '     '

/** A clickable row span: [start, end) line offsets within the last render
 *  output. `index` is the ABSOLUTE option index (window-aware). */
interface RowSpan {
  readonly start: number
  readonly end: number
  readonly index: number
}

/** The wire item plus the local wizard extension (`hideCustomInput`, set by
 *  /provider-style wizards — see providerWizard.ts; carried through the store
 *  verbatim). Ignored when there are no options — a text-only question would
 *  otherwise be unanswerable. */
type PanelQuestion = QuestionSnapshot['question'] & { readonly hideCustomInput?: boolean }

export class QuestionPanelView implements Component {
  private snapshot: QuestionSnapshot | null = null
  /** The key of the snapshot the state below belongs to (remount marker). */
  private key: string | null = null
  private focusIndex = 0
  private checked = new Set<number>()
  /** The custom-answer (generic) / feedback (plan-review) buffer. */
  private readonly edit = new LineEdit()
  /** Single-select label captured by typing on a focused option — submitted
   *  together with the custom text when the input row itself is Entered. */
  private attached: string | null = null
  private error: string | null = null
  /** Click hit maps recorded by the last render (panel-local line offsets):
   *  option rows (absolute indices) and the trailing input/feedback row. */
  private optionRows: RowSpan[] = []
  private inputRow: { readonly start: number; readonly end: number } | null = null

  constructor(
    private readonly commands: TuiCommands,
    private readonly ui: TUI,
  ) {}

  /** Push the current question snapshot; null hides the panel. */
  update(question: QuestionSnapshot | null): void {
    const key = question?.key ?? null
    if (key !== this.key) {
      this.key = key
      this.focusIndex = 0
      this.checked.clear()
      this.edit.reset('')
      this.attached = null
      this.error = null
    }
    this.snapshot = question
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
      this.commands.overlays.cancelQuestion()
      return
    }

    if (snapshot.question.intent?.kind === 'plan-review') {
      this.handlePlanInput(snapshot, data)
    } else {
      this.handleQuestionInput(snapshot, data)
    }
    this.ui.requestRender()
  }

  private handleQuestionInput(snapshot: QuestionSnapshot, data: string): void {
    const question = this.panelQuestion(snapshot)
    const options = question.options ?? []
    const multiSelect = question.multiSelect === true
    const hideCustomInput = question.hideCustomInput === true && options.length > 0
    const rowCount = options.length + (hideCustomInput ? 0 : 1)
    const inputFocused = !hideCustomInput && this.focusIndex === options.length

    const moveFocus = (delta: 1 | -1): void => {
      if (rowCount <= 1) return
      this.focusIndex = (this.focusIndex + delta + rowCount) % rowCount
      this.error = null
    }

    if (inputFocused) {
      if (matchesKey(data, Key.up)) { moveFocus(-1); return }
      if (matchesKey(data, Key.down)) { moveFocus(1); return }
      // Modifier-free Enter only (see the module header).
      if (matchesKey(data, Key.enter)) { this.submitInput(snapshot, options, multiSelect); return }
      if (matchesKey(data, Key.backspace)) { this.backspaceText(); return }
      if (matchesKey(data, Key.delete)) { this.edit.deleteForward(); return }
      if (matchesKey(data, Key.left)) { this.edit.moveLeft(); return }
      if (matchesKey(data, Key.right)) { this.edit.moveRight(); return }
      if (matchesKey(data, Key.home)) { this.edit.moveHome(); return }
      if (matchesKey(data, Key.end)) { this.edit.moveEnd(); return }
      const text = textInput(data)
      if (text !== undefined) {
        this.edit.insert(text)
        this.error = null
      }
      return
    }

    // A real option row.
    if (matchesKey(data, Key.up)) { moveFocus(-1); return }
    if (matchesKey(data, Key.down)) { moveFocus(1); return }
    if (matchesKey(data, Key.tab) && !hideCustomInput) {
      this.focusIndex = options.length
      this.error = null
      return
    }
    if (matchesKey(data, Key.space) && multiSelect) {
      if (this.checked.has(this.focusIndex)) this.checked.delete(this.focusIndex)
      else this.checked.add(this.focusIndex)
      return
    }
    if (matchesKey(data, Key.enter)) { this.submitOptions(snapshot, options, multiSelect); return }
    if (matchesKey(data, Key.backspace)) {
      // Edit the input row without leaving the option list.
      if (!hideCustomInput && this.edit.value !== '') this.backspaceText()
      return
    }
    // Typing on an option appends into the input row; single-select also
    // attaches this option's label so Enter carries label + text (#9).
    if (hideCustomInput) return
    const text = textInput(data)
    if (text !== undefined) {
      this.edit.append(text)
      this.error = null
      if (!multiSelect) this.attached = options[this.focusIndex]?.label ?? null
    }
  }

  private handlePlanInput(snapshot: QuestionSnapshot, data: string): void {
    const question = snapshot.question
    const options = question.options ?? []
    const rowCount = options.length + 1
    const inputFocused = this.focusIndex === options.length

    const moveFocus = (delta: 1 | -1): void => {
      this.focusIndex = (this.focusIndex + delta + rowCount) % rowCount
      this.error = null
    }

    if (inputFocused) {
      if (matchesKey(data, Key.up)) { moveFocus(-1); return }
      if (matchesKey(data, Key.down)) { moveFocus(1); return }
      if (matchesKey(data, Key.enter)) { this.submitFeedback(snapshot, options); return }
      if (matchesKey(data, Key.backspace)) { this.edit.backspace(); return }
      if (matchesKey(data, Key.delete)) { this.edit.deleteForward(); return }
      if (matchesKey(data, Key.left)) { this.edit.moveLeft(); return }
      if (matchesKey(data, Key.right)) { this.edit.moveRight(); return }
      if (matchesKey(data, Key.home)) { this.edit.moveHome(); return }
      if (matchesKey(data, Key.end)) { this.edit.moveEnd(); return }
      const text = textInput(data)
      if (text !== undefined) {
        this.edit.insert(text)
        this.error = null
      }
      return
    }

    // An option row.
    if (matchesKey(data, Key.up)) { moveFocus(-1); return }
    if (matchesKey(data, Key.down)) { moveFocus(1); return }
    if (matchesKey(data, Key.enter)) { this.submitPlanOption(snapshot, options, this.focusIndex); return }
    if (matchesKey(data, Key.backspace)) {
      if (this.edit.value !== '') this.edit.backspace()
      return
    }
    const text = textInput(data)
    if (text !== undefined) {
      // Number quick-pick submits the option outright — but only with an
      // empty buffer; with feedback pending, digits are feedback chars.
      // (The regex tests DECODED text, exactly like the retired panel's
      // `/^[1-9]$/.test(input)`, not raw key data.)
      const digit = /^[1-9]$/.test(text) ? Number(text) : 0
      if (this.edit.value === '' && digit >= 1 && digit <= options.length) {
        this.submitPlanOption(snapshot, options, digit - 1)
        return
      }
      // Typing anywhere appends to the feedback buffer and focuses the input
      // row — plan review has no "attach" semantics: approve must be clean.
      this.edit.append(text)
      this.focusIndex = options.length
      this.error = null
    }
  }

  // ── pointer ──────────────────────────────────────────────────────────

  /**
   * Click parity with the retired React panels (research §4.3), reusing the
   * keyboard actions rather than copying business logic:
   *
   * - Option row, plan-review: focus the row + Enter (`submitPlanOption`).
   * - Option row, multi-select: toggle the checkmark (Space).
   * - Option row, single-select: answer immediately — focus + Enter on the
   *   row (`submitOptions`, so typed custom text rides along).
   * - Input/feedback row: focus it (Tab) — a click never submits text.
   *
   * Every event reaching this handler lies inside the panel rect and is
   * consumed (blocking modal); blank cells and non-row regions consume
   * without acting.
   */
  handlePointer(event: PointerEvent): boolean | void {
    const snapshot = this.snapshot
    if (snapshot === null) return undefined
    if (event.type === 'click' && event.button === 0 && !event.cellIsBlank) {
      this.clickRow(snapshot, event.localY)
    }
    return true
  }

  private clickRow(snapshot: QuestionSnapshot, row: number): void {
    const question = this.panelQuestion(snapshot)
    const options = question.options ?? []
    const hideCustomInput = question.hideCustomInput === true && options.length > 0

    const hit = this.optionRows.find(span => row >= span.start && row < span.end)
    if (hit !== undefined) {
      if (snapshot.question.intent?.kind === 'plan-review') {
        this.focusIndex = hit.index
        this.submitPlanOption(snapshot, options, hit.index)
        return
      }
      if (question.multiSelect === true) {
        if (this.checked.has(hit.index)) this.checked.delete(hit.index)
        else this.checked.add(hit.index)
        this.ui.requestRender()
        return
      }
      this.focusIndex = hit.index
      this.submitOptions(snapshot, options, false)
      return
    }

    if (!hideCustomInput && this.inputRow !== null && row >= this.inputRow.start && row < this.inputRow.end) {
      this.focusIndex = options.length
      this.error = null
      this.ui.requestRender()
    }
  }

  // ── submit paths (protocol mapping) ──────────────────────────────────

  /** Enter on a real option: the option(s) plus whatever the input row holds. */
  private submitOptions(
    snapshot: QuestionSnapshot,
    options: ReadonlyArray<{ readonly label: string }>,
    multiSelect: boolean,
  ): void {
    const text = this.edit.value.trim()
    if (multiSelect) {
      const selected = this.checkedLabels(options)
      if (selected.length === 0 && text === '') {
        this.error = t('question-select-or-answer')
        return
      }
      this.answer({ selected, ...(text !== '' ? { custom: text } : {}) })
      return
    }
    const label = options[this.focusIndex]?.label
    if (label === undefined) {
      this.error = t('question-select-or-answer')
      return
    }
    this.answer({ selected: [label], ...(text !== '' ? { custom: text } : {}) })
  }

  /** Enter on the input row itself: the text, plus the attached label (or
   *  the checked labels for multi-select) when there is one. */
  private submitInput(
    snapshot: QuestionSnapshot,
    options: ReadonlyArray<{ readonly label: string }>,
    multiSelect: boolean,
  ): void {
    const text = this.edit.value.trim()
    if (multiSelect) {
      const selected = this.checkedLabels(options)
      if (selected.length === 0 && text === '') {
        this.error = t('question-answer-or-check')
        return
      }
      this.answer({ selected, ...(text !== '' ? { custom: text } : {}) })
      return
    }
    if (text === '') {
      this.error = t('question-type-answer-first')
      return
    }
    this.answer({ selected: this.attached !== null ? [this.attached] : [], custom: text })
  }

  /** Plan-review Enter on an option row. Approve with feedback in the buffer
   *  is an error — the protocol would silently read it as keep-planning. */
  private submitPlanOption(
    snapshot: QuestionSnapshot,
    options: ReadonlyArray<{ readonly label: string }>,
    index: number,
  ): void {
    const label = options[index]?.label
    if (label === undefined) return
    const approveLabel = this.approveLabel(snapshot, options)
    const text = this.edit.value.trim()
    if (label === approveLabel && text !== '') {
      this.error = t('plan-review-approve-needs-empty')
      return
    }
    if (label === approveLabel) {
      this.answer({ selected: [label] })
      return
    }
    this.answer({ selected: [label], ...(text !== '' ? { custom: text } : {}) })
  }

  /** Plan-review Enter on the feedback row: text routes to
   *  keep-planning-with-feedback; empty is a plain keep-planning. */
  private submitFeedback(
    snapshot: QuestionSnapshot,
    options: ReadonlyArray<{ readonly label: string }>,
  ): void {
    const text = this.edit.value.trim()
    const declineLabel = options.find(option => option.label !== this.approveLabel(snapshot, options))?.label
    // The other option's label when the asker named one, else an empty
    // selection (plan-mode reads any non-approve as decline).
    this.answer({ selected: declineLabel !== undefined ? [declineLabel] : [], ...(text !== '' ? { custom: text } : {}) })
  }

  private answer(selection: QuestionSelection): void {
    this.commands.overlays.answerQuestion(selection)
  }

  private backspaceText(): void {
    const wasEmpty = this.edit.value === ''
    this.edit.backspace()
    if (!wasEmpty && this.edit.value === '') this.attached = null
  }

  private checkedLabels(options: ReadonlyArray<{ readonly label: string }>): string[] {
    return [...this.checked].sort((a, b) => a - b).map(index => options[index]?.label)
      .filter((label): label is string => label !== undefined)
  }

  private approveLabel(
    snapshot: QuestionSnapshot,
    options: ReadonlyArray<{ readonly label: string }>,
  ): string | undefined {
    return snapshot.question.intent?.kind === 'plan-review'
      ? snapshot.question.intent.approve
      : options[0]?.label
  }

  private panelQuestion(snapshot: QuestionSnapshot): PanelQuestion {
    return snapshot.question as PanelQuestion
  }

  // ── render ───────────────────────────────────────────────────────────

  render(width: number): string[] {
    const snapshot = this.snapshot
    if (snapshot === null) return []
    this.optionRows = []
    this.inputRow = null
    return snapshot.question.intent?.kind === 'plan-review'
      ? this.renderPlanReview(snapshot, width)
      : this.renderQuestion(snapshot, width)
  }

  private renderQuestion(snapshot: QuestionSnapshot, width: number): string[] {
    const question = this.panelQuestion(snapshot)
    const options = question.options ?? []
    const multiSelect = question.multiSelect === true
    const hideCustomInput = question.hideCustomInput === true && options.length > 0
    const inputFocused = !hideCustomInput && this.focusIndex === options.length
    const claude = themePainter('claude')
    const suggestion = themePainter('suggestion')

    const remaining = snapshot.total - snapshot.answered
    const headerTitle = ` ${t('question-header-progress', {
      position: snapshot.position,
      total: snapshot.total,
      remaining: remaining > 1 ? t('question-remaining-more', { n: remaining }) : '',
    })} `

    const lines: string[] = ['']
    lines.push(PAD + dividerLine(width - 4, headerTitle, 'permission'))
    lines.push('')

    if (question.header !== undefined) {
      lines.push(PAD + suggestion(bold(`◈ ${question.header}`)))
    }
    for (const line of wrapTextWithAnsi(question.question, Math.max(1, width - 4))) {
      lines.push(PAD + bold(line))
    }
    if (question.detail !== undefined) {
      lines.push('')
      for (const detailLine of question.detail.split('\n')) {
        for (const line of wrapTextWithAnsi(detailLine, Math.max(1, width - 4))) {
          lines.push(PAD + dim(italic(line)))
        }
      }
    }

    lines.push('')
    this.renderOptionRows(lines, snapshot, options, multiSelect, width)
    if (!hideCustomInput) this.renderInputRow(lines, options, inputFocused, width)

    if (this.error !== null) {
      lines.push('')
      lines.push(PAD + themePainter('error')(this.error))
    }

    const hintParts = inputFocused
      ? [
          t('question-hint-type'),
          t('question-hint-enter'),
          ...(options.length > 0 ? [t('question-hint-back')] : []),
          t('question-hint-esc'),
          ...(multiSelect && this.checked.size > 0 ? [t('question-hint-selected', { n: this.checked.size })] : []),
        ]
      : [
          t('question-hint-select'),
          ...(multiSelect ? [t('question-hint-multi')] : []),
          ...(hideCustomInput ? [] : [t('question-hint-attach')]),
          t('question-hint-enter'),
          t('question-hint-esc'),
          ...(multiSelect && this.checked.size > 0 ? [t('question-hint-selected', { n: this.checked.size })] : []),
        ]
    lines.push('')
    lines.push(PAD + dim(hintParts.join(' · ')))
    return lines
  }

  /**
   * The option list. Chat chrome + panel scaffolding consume twelve rows
   * before the list (same reservation the retired panel made); long lists
   * window around the focus with fixed one/two-line rows so the focus stays
   * visible, short questionnaires keep the wrapped presentation.
   */
  private renderOptionRows(
    lines: string[],
    snapshot: QuestionSnapshot,
    options: ReadonlyArray<{ readonly label: string; readonly description?: string }>,
    multiSelect: boolean,
    width: number,
  ): void {
    const question = this.panelQuestion(snapshot)
    const hideCustomInput = question.hideCustomInput === true && options.length > 0
    const detailRows = question.detail === undefined ? 0 : question.detail.split('\n').length + 1
    const reservedRows = 12
      + (question.header === undefined ? 0 : 1)
      + detailRows
      + (hideCustomInput ? 0 : 1)
      + (this.error === null ? 0 : 2)
    const optionBudget = Math.max(this.ui.terminal.rows - reservedRows, 2)
    const optionHeights = options.map(option => (option.description === undefined ? 1 : 2))
    const windowed = optionHeights.reduce((sum, height) => sum + height, 0) > optionBudget
    const optionFocus = Math.min(this.focusIndex, Math.max(options.length - 1, 0))
    const window_ = windowed
      ? listWindow(optionHeights, optionFocus, optionBudget)
      : { start: 0, end: options.length }
    const labelWidth = Math.max(1, width - 7)
    const claude = themePainter('claude')

    for (let index = window_.start; index < window_.end; index += 1) {
      const option = options[index]!
      const focused = index === this.focusIndex
      const selected = multiSelect ? this.checked.has(index) : focused
      const pointer = focused
        ? POINTER
        : index === window_.start && window_.start > 0
          ? '↑'
          : index === window_.end - 1 && window_.end < options.length
            ? '↓'
            : ' '
      if (!windowed && focused) lines.push('') // the old row's marginTop
      const start = lines.length
      const pointerCell = focused ? claude(bold(pointer)) : pointer
      const checkCell = selected ? (multiSelect ? CHECKED : SINGLE_SELECTED) : UNCHECKED
      const checkStyled = focused ? claude(selected ? bold(checkCell) : checkCell) : selected ? bold(checkCell) : checkCell

      const label = windowed ? option.label.replace(/\s+/gu, ' ').trim() : option.label
      const labelLines = windowed
        ? [truncateToWidth(label, labelWidth, '')]
        : wrapTextWithAnsi(label, labelWidth)
      for (const [lineIndex, line] of labelLines.entries()) {
        const text = focused ? claude(bold(line)) : selected ? bold(line) : line
        lines.push(lineIndex === 0 ? `${PAD}${pointerCell}${checkStyled} ${text}` : `${LABEL_PAD}${text}`)
      }

      if (option.description !== undefined) {
        const description = windowed ? option.description.replace(/\s+/gu, ' ').trim() : option.description
        const descriptionLines = windowed
          ? [truncateToWidth(description, labelWidth, '')]
          : wrapTextWithAnsi(description, labelWidth)
        for (const line of descriptionLines) {
          lines.push(LABEL_PAD + dim(line))
        }
      }
      this.optionRows.push({ start, end: lines.length, index })
    }
  }

  /** The trailing free-text row: pointer + pencil + label + the edit buffer
   *  with the caret (inverse cell when focused, `▏` otherwise) and the IME
   *  cursor marker at the caret whenever the row is visible. */
  private renderInputRow(
    lines: string[],
    options: ReadonlyArray<{ readonly label: string }>,
    inputFocused: boolean,
    width: number,
  ): void {
    const claude = themePainter('claude')
    const suggestion = themePainter('suggestion')
    if (inputFocused) lines.push('') // the old row's marginTop

    const pointer = inputFocused ? claude(bold(POINTER)) : ' '
    const pencil = inputFocused ? claude(PENCIL) : suggestion(PENCIL)
    const label = inputFocused ? claude(bold(t('question-custom-tab'))) : suggestion(t('question-custom-tab'))
    const attached = this.attached !== null ? suggestion(t('question-attached-label', { label: this.attached })) : ''
    const colon = dim('：')
    const content = this.edit.value === '' && !inputFocused
      ? CURSOR_MARKER + dim(t('question-direct-input'))
      : this.edit.before()
        + CURSOR_MARKER
        + (inputFocused ? inverse(this.edit.at()) : suggestion('▏'))
        + this.edit.after(inputFocused)

    const tailWidth = Math.max(1, width - 5)
    const tail = `${label}${attached}${colon}${content}`
    const start = lines.length
    for (const [lineIndex, line] of wrapTextWithAnsi(tail, tailWidth).entries()) {
      lines.push(lineIndex === 0 ? `${PAD}${pointer}${pencil} ${line}` : `${LABEL_PAD}${line}`)
    }
    this.inputRow = { start, end: lines.length }
  }

  private renderPlanReview(snapshot: QuestionSnapshot, width: number): string[] {
    const question = snapshot.question
    const options = question.options ?? []
    const approveLabel = this.approveLabel(snapshot, options)
    const inputFocused = this.focusIndex === options.length
    const claude = themePainter('claude')
    const suggestion = themePainter('suggestion')

    const lines: string[] = ['']
    lines.push(PAD + dividerLine(width - 4, ` ${question.header ?? t('plan-review-fallback-header')} `, 'permission'))
    lines.push('')

    for (const line of wrapTextWithAnsi(question.question, Math.max(1, width - 4))) {
      lines.push(PAD + bold(line))
    }
    if (question.detail !== undefined) {
      lines.push('')
      // The retired panel ran the plan through the React Markdown renderer;
      // the pi-tui Markdown theme is the message-list migration's to define
      // (WP-03), so the detail renders as plain wrapped lines for now.
      for (const detailLine of question.detail.split('\n')) {
        for (const line of wrapTextWithAnsi(detailLine, Math.max(1, width - 4))) {
          lines.push(PAD + line)
        }
      }
    }

    lines.push('')
    const labelWidth = Math.max(1, width - 5)
    for (const [index, option] of options.entries()) {
      const focused = index === this.focusIndex
      const isApprove = option.label === approveLabel
      if (focused) lines.push('') // the old row's marginTop
      const start = lines.length
      const pointer = focused ? claude(bold(POINTER)) : ' '
      const label = `${index + 1}. ${option.label}`
      const labelLines = wrapTextWithAnsi(label, labelWidth)
      for (const [lineIndex, line] of labelLines.entries()) {
        const text = focused ? claude(bold(line)) : isApprove ? claude(line) : line
        lines.push(lineIndex === 0 ? `${PAD}${pointer} ${text}` : `${PAD}  ${text}`)
      }
      if (option.description !== undefined) {
        for (const line of wrapTextWithAnsi(option.description, labelWidth)) {
          lines.push(`${PAD}  ${dim(line)}`)
        }
      }
      this.optionRows.push({ start, end: lines.length, index })
    }

    if (inputFocused) lines.push('')
    const pointer = inputFocused ? claude(bold(POINTER)) : ' '
    const pencil = inputFocused ? claude(PENCIL) : suggestion(PENCIL)
    const content = this.edit.value === '' && !inputFocused
      ? CURSOR_MARKER + dim(t('plan-review-feedback-placeholder'))
      : this.edit.before()
        + CURSOR_MARKER
        + (inputFocused ? inverse(this.edit.at()) : suggestion('▏'))
        + this.edit.after(inputFocused)
    const feedbackWidth = Math.max(1, width - 5)
    const feedbackStart = lines.length
    for (const [lineIndex, line] of wrapTextWithAnsi(content, feedbackWidth).entries()) {
      lines.push(lineIndex === 0 ? `${PAD}${pointer}${pencil} ${line}` : `${PAD}   ${line}`)
    }
    this.inputRow = { start: feedbackStart, end: lines.length }

    if (this.error !== null) {
      lines.push('')
      lines.push(PAD + themePainter('error')(this.error))
    }

    lines.push('')
    lines.push(PAD + dim(t('plan-review-hint')))
    return lines
  }
}
