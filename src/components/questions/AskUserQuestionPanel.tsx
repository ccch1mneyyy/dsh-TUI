/**
 * The questionnaire panel — ask-user-question UI for the
 * DSH user-interaction seam. One question per panel (progress header, header
 * chip, wrapped question text, optional detail, option list with focus
 * pointer and multi-select checkmarks), styled in the dsh-tui mist-blue
 * design language.
 *
 * The list's last row IS the free-text input (issue #9): no Tab, no mode
 * switch — the view never changes. Typing while focused on a real option
 * appends into that input row (single-select also attaches the option's
 * label, so the answer can carry both `selected` and `custom`); focusing
 * the input row itself and typing gives a pure custom answer.
 *
 * Paste works on the input row like the composer: Ctrl+V/Alt+V (the keymap
 * `paste` binding, remappable in /settings) reads the system clipboard,
 * and a terminal bracketed paste (Ctrl+Shift+V / right-click / terminals
 * that intercept Ctrl+V) inserts its chunk — newlines and control chars are
 * flattened to spaces, pasted content never submits the panel. Editing
 * state (value + caret) lives in refs mutated synchronously per event: a
 * terminal delivers one stdin chunk as several key events inside a single
 * React batch, and the clipboard read resolves asynchronously — state
 * queued by one event is invisible to the next, and a paste must land at
 * the caret the user actually sees. The caret counts CODE POINTS (`[...s]`
 * iteration, same contract as the plugin InputDialog), so an emoji can
 * never be split into a lone surrogate by ←/→/⌫/Del or a paste boundary.
 */

import React from 'react'
import { t } from '../../i18n.js'
import { Box, Text, useInput, useTerminalSize } from '../../ui.js'
import { useDeclaredCursor } from '../../ink/hooks/use-declared-cursor.js'
import { Divider } from '../design-system/Divider.js'
import { POINTER } from '../../terminal-utils/figures.js'
import type { QuestionDraft, QuestionSelection } from '../../dsh-adapter/questions.js'
import { PlanReviewPanel } from './PlanReviewPanel.js'
import { QuestionMinimizedBar } from './QuestionMinimizedBar.js'
import { isPlainReturnInput } from '../../utils/modifiers.js'
import { actionMatches, effectiveComboDisplay } from '../../utils/keymap.js'
import { flattenPasteInline } from '../../dsh-adapter/sanitize.js'
import { readClipboard, type ClipboardRead } from '../../utils/clipboard.js'
import { listWindow } from '../listWindow.js'

const CHECKED = '◉'
const UNCHECKED = '○'
const PENCIL = '✎'

/**
 * Paste cap for one answer field, in code points. Typing is naturally
 * bounded (humans cannot type unboundedly) and the protocol places no
 * limit on `custom`, but a stray Ctrl+V of a file/log must not inflate the
 * panel to hundreds of wrapped rows (every keystroke then re-lays them
 * out) or ship a megabyte answer. Deliberately generous — anything past it
 * is an accident, and the inline error says exactly that. Twin constant in
 * PlanReviewPanel (the two panels share the same input contract).
 */
const ANSWER_PASTE_MAX_POINTS = 8000

export type AskUserQuestionPanelProps = {
  /** The question to render (from the QuestionStore snapshot). */
  readonly question: {
    readonly question: string
    readonly header?: string
    readonly detail?: string
    readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }>
    readonly multiSelect?: boolean
    /** Hide the trailing free-text input row for pure option questions
     *  (local wizards, e.g. /provider). Ignored when there are no options —
     *  a text-only question would otherwise be unanswerable. */
    readonly hideCustomInput?: boolean
    /** Pre-checked option labels (multi-select) / default-focused option
     *  (single-select) shown on first display, before any saved draft — e.g.
     *  the models already enabled on a provider being edited. */
    readonly defaultSelected?: readonly string[]
    /** Presentation intent tag (rc.6): 'plan-review' switches to the
     *  decision-card layout; an intent never changes the protocol. */
    readonly intent?: { readonly kind: 'plan-review'; readonly approve: string }
  }
  /** 1-based position within the batch (progress header). */
  readonly position: number
  /** Total questions in the batch (progress header). */
  readonly total: number
  /** Questions answered before the current one. */
  readonly answered: number
  /** Previously saved answer or draft, restored when returning to this item. */
  readonly initialDraft?: QuestionDraft
  readonly onAnswer: (selection: QuestionSelection) => void
  /** Esc on the first question / Ctrl+C — aborts the whole ask. */
  readonly onCancel: () => void
  /** Esc on later questions — navigates to the previous question. */
  readonly onBack?: (draft: QuestionDraft) => void
  /**
   * Test seam: clipboard reader for the Ctrl+V paste arm. Defaults to the
   * real cross-platform reader (PowerShell/pbpaste/wl-paste…); headless
   * verification injects a fake so paste outcomes are deterministic.
   */
  readonly readClipboardOverride?: () => Promise<ClipboardRead>
  /**
   * Manual collapse (question panel fold, default Ctrl+K): while
   * collapsed the panel STAYS MOUNTED — draft refs survive, the fold
   * branch sits after every hook — and renders the two-line minimized
   * bar instead, with its input/caret layers gated off. Esc/Ctrl+C then
   * mean "expand", never cancel (Chat routes them while folded).
   */
  readonly collapsed?: boolean
  /** Expand back from the minimized bar (fold key / Esc / mouse click). */
  readonly onExpand?: () => void
  /** Fold from the expanded panel (fold key / header-row click). */
  readonly onToggleFold?: () => void
  /** True when mouse tracking is on: mouse-only affordances (the
   *  multi-select submit row) render only then — inline hosts have no
   *  pointer, so an unclickable row would just eat a line. */
  readonly fullscreen?: boolean
}

export function AskUserQuestionPanel({
  question,
  position,
  total,
  answered,
  initialDraft,
  onAnswer,
  onCancel,
  onBack,
  readClipboardOverride,
  collapsed = false,
  onExpand,
  onToggleFold,
  fullscreen = false,
}: AskUserQuestionPanelProps): React.ReactNode {
  // Plan-mode's exit_plan_mode ask carries a presentation intent: render
  // the plan decision card instead of the generic questionnaire. The
  // branch precedes every hook so hook order stays stable per remount key.
  if (question.intent?.kind === 'plan-review') {
    return <PlanReviewPanel
      question={question}
      onAnswer={onAnswer}
      onCancel={onCancel}
      readClipboardOverride={readClipboardOverride}
    />
  }
  const options = question.options ?? []
  const multiSelect = question.multiSelect === true
  const hideCustomInput = question.hideCustomInput === true && options.length > 0
  const { rows: terminalRows } = useTerminalSize()
  /** Rows: the real options plus the inline input row at the tail. */
  const rowCount = options.length + (hideCustomInput ? 0 : 1)
  // A saved draft wins over the wizard's default selection (returning to a
  // question must restore exactly what the user last had, including an
  // explicit empty answer); the defaults only apply on first display.
  const initialSelected = initialDraft !== undefined
    ? initialDraft.selected
    : question.defaultSelected ?? []
  const initialCustom = initialDraft?.custom ?? ''
  const selectedIndices = options
    .map((option, index) => initialSelected.includes(option.label) ? index : -1)
    .filter(index => index >= 0)
  const initialFocus = initialCustom !== '' && selectedIndices.length === 0 && !hideCustomInput
    ? options.length
    : selectedIndices[0] ?? 0
  const [focusIndex, setFocusIndex] = React.useState(initialFocus)
  const [checked, setChecked] = React.useState<ReadonlySet<number>>(
    () => new Set(multiSelect ? selectedIndices : []),
  )
  const [customText, setCustomText] = React.useState(initialCustom)
  const [customCursor, setCustomCursor] = React.useState(() => [...initialCustom].length)
  // Synchronous source of truth for the handlers (see the module header):
  // keys of one stdin batch share a single React update, and the clipboard
  // read resolves asynchronously — the state mirrors exist only to re-render.
  const textRef = React.useRef(initialCustom)
  const cursorRef = React.useRef([...initialCustom].length)
  /** Single choke point for every text/caret mutation: refs first, then the
   *  state mirrors so the render sees the committed value. */
  const applyText = (nextText: string, nextCursor: number): void => {
    textRef.current = nextText
    cursorRef.current = nextCursor
    setCustomText(nextText)
    setCustomCursor(nextCursor)
  }
  /** True while the component is mounted (async clipboard continuation
   *  guard: the panel can unmount when the user answers before the read
   *  resolves). */
  const mountedRef = React.useRef(true)
  React.useEffect(() => () => { mountedRef.current = false }, [])
  /** True while a clipboard read is in flight (ignore repeat Ctrl+V). */
  const pasteBusyRef = React.useRef(false)
  const clipboardReader = readClipboardOverride ?? readClipboard
  /** Single-select label captured by typing on a focused option — submitted
   *  together with the custom text when the input row itself is Entered. */
  const [attached, setAttached] = React.useState<string | null>(
    () => initialCustom !== '' && !multiSelect ? (initialSelected[0] ?? null) : null,
  )
  const [error, setError] = React.useState<string | null>(null)

  const inputFocused = !hideCustomInput && focusIndex === options.length
  // Chat chrome + panel scaffolding consume twelve rows before the option
  // list: status line, outer/divider/question/list/hint spacing and content.
  // Optional header/detail/input/error rows are charged explicitly. Long
  // lists then use fixed one/two-line rows so listWindow's budget is exact;
  // short questionnaires retain their existing wrapped presentation.
  const detailRows = question.detail === undefined ? 0 : question.detail.split('\n').length + 1
  const reservedRows = 12
    + (question.header === undefined ? 0 : 1)
    + detailRows
    + (hideCustomInput ? 0 : 1)
    + (error === null ? 0 : 2)
  const optionBudget = Math.max(terminalRows - reservedRows, 2)
  const optionHeights = options.map(option => option.description === undefined ? 1 : 2)
  const windowedOptions = optionHeights.reduce((sum, height) => sum + height, 0) > optionBudget
  const optionFocus = Math.min(focusIndex, Math.max(options.length - 1, 0))
  const optionWindow = windowedOptions
    ? listWindow(optionHeights, optionFocus, optionBudget)
    : { start: 0, end: options.length }

  // Park the native terminal cursor on the custom-answer caret: terminal
  // emulators render IME preedit (pinyin) at the physical cursor, so without
  // this declaration CJK composition appears at the screen's bottom row
  // instead of inline at the input (same mechanism as PromptInput's value
  // box). Active whenever the input row is visible — typing on an option row
  // also lands in this input, so the IME anchor must follow even when the
  // row itself is not focused. The ref rides on the caret Text itself (all
  // three visual variants): its nodeCache rect IS the caret cell, so (0, 0)
  // stays exact under CJK widths and line wrapping without any
  // layout-affecting wrapper Box.
  const caretRef = useDeclaredCursor({ line: 0, column: 0, active: !hideCustomInput && !collapsed })

  const moveFocus = (delta: 1 | -1): void => {
    if (rowCount <= 1) return
    setFocusIndex(index => (index + delta + rowCount) % rowCount)
    setError(null)
  }

  /** Append at the text tail (option-row typing has no visible cursor). */
  const appendText = (text: string): void => {
    applyText(textRef.current + text, cursorRef.current + [...text].length)
    setError(null)
  }

  /** Drop the character before the caret; empty text drops the attach. */
  const backspaceText = (): void => {
    const points = [...textRef.current]
    const at = cursorRef.current
    if (at <= 0) return
    points.splice(at - 1, 1)
    const next = points.join('')
    if (next === '') setAttached(null)
    applyText(next, at - 1)
  }

  /**
   * Paste-path entry shared by both transports (bracketed-paste chunk and
   * the async clipboard read). Single-line field: newlines and control
   * chars flatten to spaces; a chunk with nothing visible (blank lines or
   * stray controls only) inserts nothing, and one past the cap is refused
   * (never truncated — the user must see that text was dropped). Where the
   * text lands mirrors plain typing — at the caret while the input row is
   * focused, appended at the tail (and the option's label attached,
   * single-select) when typing on an option row would append.
   * @returns 'ok' | 'empty' (nothing visible to insert) | 'too-long'
   */
  const insertPastedText = (raw: string, atCaret: boolean): 'ok' | 'empty' | 'too-long' => {
    const text = flattenPasteInline(raw)
    if (text.trim() === '') return 'empty'
    if ([...text].length > ANSWER_PASTE_MAX_POINTS) return 'too-long'
    const points = [...textRef.current]
    const at = atCaret ? cursorRef.current : points.length
    points.splice(at, 0, ...text)
    applyText(points.join(''), at + [...text].length)
    if (!atCaret && !multiSelect) setAttached(options[focusIndex]?.label ?? null)
    return 'ok'
  }

  /** Inline error for an over-cap paste (shared by both transports). */
  const pasteTooLongError = (): string =>
    t('question-paste-too-long', { n: ANSWER_PASTE_MAX_POINTS })

  /** Ctrl+V/Alt+V arm: read the system clipboard and insert its text. */
  const pasteFromClipboard = (): void => {
    if (pasteBusyRef.current) return
    pasteBusyRef.current = true
    // Option-row typing appends at the tail; capture which semantics the
    // keypress asked for — the read resolves later, after the user may
    // have moved focus or typed (the refs make either safe).
    const atCaret = inputFocused
    void clipboardReader()
      .then(content => {
        if (!mountedRef.current) return
        if (content === null || content.kind === 'unavailable') {
          setError(t(content === null ? 'input-clipboard-empty' : 'input-clipboard-unavailable'))
          return
        }
        if (content.kind !== 'text') {
          // File/image offers have no text form in an answer field.
          setError(t('question-paste-not-text'))
          return
        }
        if (content.text === '') {
          setError(t('input-clipboard-empty'))
          return
        }
        const result = insertPastedText(content.text, atCaret)
        setError(result === 'too-long' ? pasteTooLongError() : null)
      })
      .catch(() => {
        if (mountedRef.current) setError(t('input-clipboard-read-failed'))
      })
      .finally(() => {
        pasteBusyRef.current = false
      })
  }

  const checkedLabels = (): string[] =>
    [...checked].sort((a, b) => a - b).map(index => options[index]?.label)
      .filter((label): label is string => label !== undefined)

  /** Enter on a real option: the option(s) plus whatever the input row holds. */
  const submitOptions = (): void => {
    const text = textRef.current.trim()
    if (multiSelect) {
      const selected = checkedLabels()
      if (selected.length === 0 && text === '') {
        setError(t('question-select-or-answer'))
        return
      }
      onAnswer({ selected, ...(text !== '' ? { custom: text } : {}) })
      return
    }
    const label = options[focusIndex]?.label
    if (label === undefined) {
      setError(t('question-select-or-answer'))
      return
    }
    onAnswer({ selected: [label], ...(text !== '' ? { custom: text } : {}) })
  }

  /** Enter on the input row itself: the text, plus the attached label (or
   *  the checked labels for multi-select) when there is one. */
  const submitInput = (): void => {
    const text = textRef.current.trim()
    if (multiSelect) {
      const selected = checkedLabels()
      if (selected.length === 0 && text === '') {
        setError(t('question-answer-or-check'))
        return
      }
      onAnswer({ selected, ...(text !== '' ? { custom: text } : {}) })
      return
    }
    if (text === '') {
      setError(t('question-type-answer-first'))
      return
    }
    onAnswer({ selected: attached !== null ? [attached] : [], custom: text })
  }

  /** Capture the visible answer state before navigating away. */
  const currentDraft = (): QuestionDraft => {
    const selected = multiSelect
      ? checkedLabels()
      : inputFocused
        ? (attached === null ? [] : [attached])
        : (() => {
            const label = options[focusIndex]?.label
            return label === undefined ? [] : [label]
          })()
    return {
      selected,
      ...(textRef.current !== '' ? { custom: textRef.current } : {}),
    }
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onCancel()
      return
    }
    if (key.escape) {
      if (onBack !== undefined) onBack(currentDraft())
      else onCancel()
      return
    }

    // ── Paste ─────────────────────────────────────────────────────────
    // A bracketed paste (terminal Ctrl+Shift+V / right-click / a terminal
    // that intercepts Ctrl+V) arrives as ONE chunk flagged isPasted. Where
    // it lands mirrors plain typing: on an option row it appends at the
    // tail (and attaches the option's label, single-select), on the input
    // row it inserts at the caret. It never submits — a chunk that is all
    // line breaks is text, not an Enter press (isPlainReturnInput refuses
    // pastes; the flattened text may also be empty → nothing to insert).
    if (key.isPasted === true) {
      if (!hideCustomInput && input !== '') {
        const result = insertPastedText(input, inputFocused)
        setError(result === 'too-long' ? pasteTooLongError() : null)
      }
      return
    }
    // Clipboard paste (default Ctrl+V / Alt+V — the keymap `paste`
    // binding, remappable in /settings): raw mode hands the key to the
    // app, so the clipboard is read here (mirrors the composer's arm).
    if (actionMatches('paste', input, key)) {
      if (!hideCustomInput) pasteFromClipboard()
      return
    }

    if (inputFocused) {
      if (key.upArrow) {
        moveFocus(-1)
        return
      }
      if (key.downArrow) {
        moveFocus(1)
        return
      }
      if (isPlainReturnInput(input, key)) {
        submitInput()
        return
      }
      if (key.backspace) {
        backspaceText()
        return
      }
      if (key.delete) {
        const points = [...textRef.current]
        const at = cursorRef.current
        if (at < points.length) {
          points.splice(at, 1)
          const next = points.join('')
          if (next === '') setAttached(null)
          applyText(next, at)
        }
        return
      }
      if (key.leftArrow) {
        applyText(textRef.current, Math.max(0, cursorRef.current - 1))
        return
      }
      if (key.rightArrow) {
        applyText(textRef.current, Math.min([...textRef.current].length, cursorRef.current + 1))
        return
      }
      if (key.home) {
        applyText(textRef.current, 0)
        return
      }
      if (key.end) {
        applyText(textRef.current, [...textRef.current].length)
        return
      }
      if (!key.ctrl && !key.meta && !key.super && input) {
        // Ordinary typing at the live caret (a text run may carry several
        // characters in one event — e.g. an unbracketed terminal paste).
        const points = [...textRef.current]
        const at = cursorRef.current
        points.splice(at, 0, ...input)
        applyText(points.join(''), at + [...input].length)
        setError(null)
      }
      return
    }

    // A real option row.
    if (key.upArrow) {
      moveFocus(-1)
      return
    }
    if (key.downArrow) {
      moveFocus(1)
      return
    }
    if (key.tab && !hideCustomInput) {
      setFocusIndex(options.length)
      setError(null)
      return
    }
    if (input === ' ' && multiSelect) {
      setChecked(previous => {
        const next = new Set(previous)
        if (next.has(focusIndex)) next.delete(focusIndex)
        else next.add(focusIndex)
        return next
      })
      return
    }
    if (isPlainReturnInput(input, key)) {
      submitOptions()
      return
    }
    if (key.backspace) {
      // Edit the input row without leaving the option list.
      if (!hideCustomInput && textRef.current !== '') backspaceText()
      return
    }
    // Typing on an option appends into the input row; single-select also
    // attaches this option's label so Enter carries label + text (#9).
    if (!hideCustomInput && !key.ctrl && !key.meta && !key.super && input) {
      appendText(input)
      if (!multiSelect) setAttached(options[focusIndex]?.label ?? null)
    }
  }, { isActive: !collapsed })

  const remaining = total - answered
  /** Fold shortcut label for the hint row (follows /settings remaps). */
  const foldCombo = effectiveComboDisplay('questionFold')
  const headerTitle = ` ${t('question-header-progress', { position, total, remaining: remaining > 1 ? t('question-remaining-more', { n: remaining }) : '' })} `
  /** First line of the question body for the minimized bar (whitespace
   *  flattened the same way windowedOptions flattens labels). */
  const questionText = question.question.split('\n')[0]?.replace(/\s+/gu, ' ').trim() ?? ''

  // The caret counts code points (see the module header), so the caret
  // char and the visual split index into the point array — never raw
  // UTF-16 offsets, which could land inside a surrogate pair.
  const textPoints = [...customText]
  const cursorChar = customCursor < textPoints.length ? textPoints[customCursor] : ' '
  /** Mouse: click the input row to focus it (same as Tab). */
  const focusInputRow = (): void => {
    if (hideCustomInput) return
    setFocusIndex(options.length)
    setError(null)
  }
  /**
   * Mouse: click an option row. Multi-select toggles the checkmark (same as
   * Space); single-select answers immediately with that option plus any
   * typed text (same as focusing the row and pressing Enter) — one click =
   * one answer, matching ApprovalPanel's click semantics.
   */
  const clickOption = (index: number): void => {
    if (multiSelect) {
      setChecked(previous => {
        const next = new Set(previous)
        if (next.has(index)) next.delete(index)
        else next.add(index)
        return next
      })
      return
    }
    const label = options[index]?.label
    if (label === undefined) return
    const text = textRef.current.trim()
    onAnswer({ selected: [label], ...(text !== '' ? { custom: text } : {}) })
  }
  const [hoverIndex, setHoverIndex] = React.useState(-1)
  /** Header row hover — the row doubles as the mouse fold/unfold affordance. */
  const [headerHovered, setHeaderHovered] = React.useState(false)
  /** Mouse submit row hover (multi-select: clicking submits the checked set). */
  const [submitHovered, setSubmitHovered] = React.useState(false)
  const renderInputRow = (): React.ReactNode => (
    <Box
      flexDirection="row"
      marginTop={inputFocused ? 1 : 0}
      onClick={focusInputRow}
      onMouseEnter={() => setHoverIndex(options.length)}
      onMouseLeave={() => setHoverIndex(current => (current === options.length ? -1 : current))}
      backgroundColor={hoverIndex === options.length && !inputFocused ? 'userMessageBackgroundHover' : undefined}
    >
      <Box width={1} flexShrink={0}>
        <Text color={inputFocused ? 'accent' : undefined} bold={inputFocused}>
          {inputFocused ? POINTER : ' '}
        </Text>
      </Box>
      <Box width={1} flexShrink={0}>
        <Text color={inputFocused ? 'accent' : 'suggestion'}>{PENCIL}</Text>
      </Box>
      <Box flexDirection="row" marginLeft={1}>
        <Text bold={inputFocused} color={inputFocused ? 'accent' : 'suggestion'}>
          {t('question-custom-tab')}
        </Text>
        {attached !== null && (
          <Text color="suggestion">{t('question-attached-label', { label: attached })}</Text>
        )}
        <Text dimColor>：</Text>
        {customText === '' && !inputFocused ? (
          <Text ref={caretRef} dimColor>{t('question-direct-input')}</Text>
        ) : (
          <>
            <Text wrap="wrap">{textPoints.slice(0, customCursor).join('')}</Text>
            {inputFocused
              ? <Text ref={caretRef} inverse>{cursorChar}</Text>
              : <Text ref={caretRef} color="suggestion">▏</Text>}
            <Text wrap="wrap">{textPoints.slice(inputFocused ? customCursor + 1 : customCursor).join('')}</Text>
          </>
        )}
      </Box>
    </Box>
  )

  const renderOptions = (): React.ReactNode => (
    <Box flexDirection="column" marginTop={1}>
      {options.slice(optionWindow.start, optionWindow.end).map((option, index) => {
        const absoluteIndex = optionWindow.start + index
        const focused = absoluteIndex === focusIndex
        const selected = multiSelect ? checked.has(absoluteIndex) : focused
        const pointer = focused
          ? POINTER
          : absoluteIndex === optionWindow.start && optionWindow.start > 0
            ? '↑'
            : absoluteIndex === optionWindow.end - 1 && optionWindow.end < options.length
              ? '↓'
              : ' '
        const label = windowedOptions ? option.label.replace(/\s+/gu, ' ').trim() : option.label
        const description = windowedOptions
          ? option.description?.replace(/\s+/gu, ' ').trim()
          : option.description
        return (
          <Box
            key={`${absoluteIndex}:${option.label}`}
            flexDirection="row"
            marginTop={!windowedOptions && focused ? 1 : 0}
            onClick={() => clickOption(absoluteIndex)}
            onMouseEnter={() => setHoverIndex(absoluteIndex)}
            onMouseLeave={() => setHoverIndex(current => (current === absoluteIndex ? -1 : current))}
            backgroundColor={hoverIndex === absoluteIndex && !focused ? 'userMessageBackgroundHover' : undefined}
          >
            <Box width={1} flexShrink={0}>
              <Text color={focused ? 'accent' : undefined} bold={focused}>
                {pointer}
              </Text>
            </Box>
            <Box width={1} flexShrink={0}>
              <Text color={focused ? 'accent' : undefined} bold={selected}>
                {selected ? (multiSelect ? CHECKED : '●') : UNCHECKED}
              </Text>
            </Box>
            <Box flexDirection="column" marginLeft={1}>
              <Text
                bold={focused || selected}
                color={focused ? 'accent' : undefined}
                wrap={windowedOptions ? 'truncate' : 'wrap'}
              >
                {label}
              </Text>
              {description !== undefined && (
                <Text dimColor wrap={windowedOptions ? 'truncate' : 'wrap'}>
                  {description}
                </Text>
              )}
            </Box>
          </Box>
        )
      })}
      {hideCustomInput ? null : renderInputRow()}
      {multiSelect && fullscreen && (checked.size > 0 || textRef.current !== '') && (
        <Box
          flexDirection="row"
          height={1}
          marginTop={1}
          onClick={submitOptions}
          onMouseEnter={() => setSubmitHovered(true)}
          onMouseLeave={() => setSubmitHovered(false)}
          backgroundColor={submitHovered ? 'userMessageBackgroundHover' : undefined}
        >
          <Text color="accent">✓ </Text>
          <Text dimColor>{t('question-submit-selection')}</Text>
        </Box>
      )}
    </Box>
  )

  const hintParts = inputFocused
    ? [
        t('question-hint-type'),
        t('question-hint-paste'),
        t('question-hint-enter'),
        ...(options.length > 0 ? [t('question-hint-back')] : []),
        onBack === undefined ? t('question-hint-esc') : t('question-hint-previous'),
        ...(onBack === undefined ? [] : [t('question-hint-cancel')]),
        ...(multiSelect && checked.size > 0 ? [t('question-hint-selected', { n: checked.size })] : []),
        t('question-fold-hint', { combo: foldCombo }),
      ]
    : [
        t('question-hint-select'),
        ...(multiSelect ? [t('question-hint-multi')] : []),
        ...(hideCustomInput ? [] : [t('question-hint-paste'), t('question-hint-attach')]),
        t('question-hint-enter'),
        onBack === undefined ? t('question-hint-esc') : t('question-hint-previous'),
        ...(onBack === undefined ? [] : [t('question-hint-cancel')]),
        ...(multiSelect && checked.size > 0 ? [t('question-hint-selected', { n: checked.size })] : []),
        t('question-fold-hint', { combo: foldCombo }),
      ]

  // Folded: render only the minimized bar. This branch sits AFTER every
  // hook (and after the intent early-return), so folding never reorders
  // hooks and the draft refs above stay alive for the expand.
  if (collapsed) {
    return <QuestionMinimizedBar progress={headerTitle} questionText={questionText} onExpand={onExpand ?? (() => {})} />
  }

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2} paddingRight={2} width="100%">
      <Box
        flexDirection="column"
        onClick={onToggleFold}
        onMouseEnter={() => setHeaderHovered(true)}
        onMouseLeave={() => setHeaderHovered(false)}
        backgroundColor={headerHovered ? 'userMessageBackgroundHover' : undefined}
      >
        <Divider color="permission" title={`▾${headerTitle}`} />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {question.header !== undefined && (
          <Text color="suggestion" bold>
            ◈ {question.header}
          </Text>
        )}
        <Text bold wrap="wrap">
          {question.question}
        </Text>
        {question.detail !== undefined && (
          <Box flexDirection="column" marginTop={1}>
            {question.detail.split('\n').map((line, index) => (
              <Text key={index} dimColor italic wrap="wrap">
                {line}
              </Text>
            ))}
          </Box>
        )}
      </Box>
      {renderOptions()}
      {error !== null && (
        <Box marginTop={1}>
          <Text color="error">{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>{hintParts.join(' · ')}</Text>
      </Box>
    </Box>
  )
}
