/**
 * The approval panel — permission prompt for the DSH
 * approval seam (`ctx.approval`). One ask per panel: a permission-colored
 * divider header naming the tool, the gated command recovered from the
 * paired tool call, the asker's reason,
 * "Allow this operation?", and a numbered Yes/No list.
 *
 * The protocol's outcome set is closed (allowed-once / rejected /
 * cancelled / unavailable) with no allow-always or feedback channel, so
 * the panel deliberately offers exactly two rows; Esc and Ctrl+C reject
 * (fail closed; Esc cancels the request).
 *
 * Height budget (issue #1212): the fullscreen Chat frame is exactly
 * `terminalRows` tall and this panel renders inside its bottom chrome, so an
 * unbounded command/reason body pushed the decision rows — the question and
 * the two options, the rows the user has to read to answer at all — past the
 * frame bottom, where the alt screen has no scrollback to recover them. The
 * decision rows are charged first and never fold; the command and reason
 * bodies fold to their leading rows plus a folded-count marker; the cosmetic
 * margins are given up before any decision row is.
 */

import React from 'react'
import { t } from '../../i18n.js'
import { Box, Text, useInput, useTerminalSize } from '../../ui.js'
import { isPlainReturnInput } from '../../utils/modifiers.js'
import { Divider } from '../design-system/Divider.js'
import { POINTER } from '../../terminal-utils/figures.js'
import { foldedRows, foldLines, wrapText, type FoldedLines } from '../foldLines.js'
import type { ApprovalSnapshot } from '../../dsh-adapter/approvals.js'

export type ApprovalPanelProps = {
  /** The approval to render (from the ApprovalStore snapshot). */
  readonly approval: ApprovalSnapshot
  /** True when the asking agent is NOT the attached session — a background
   *  (agent view) session's ask, answered from the same single panel. */
  readonly background?: boolean
  readonly onDecide: (outcome: 'allowed-once' | 'rejected') => void
}

const OUTCOMES = ['allowed-once', 'rejected'] as const

/**
 * Rows this panel must leave for the rest of the bottom chrome. It renders
 * inside the same flexShrink={0} column as the working spinner / activity line
 * above it (2 rows while a turn is in flight — the usual state of an approval)
 * and the status line's context bar / status / hint rows below it (1-3). The
 * suspended PromptInput on the composer path renders nothing at all
 * (`if (suspended) return null`), so the prompt slot costs no row. The
 * interrupt lane renders the panel alone — budgeting for the composer slot
 * keeps both inside the fixed-height fullscreen frame; the lane merely folds a
 * little earlier than it must.
 */
const CHROME_ROWS_BELOW = 6
/** The decision surface, never folded: divider, question, the two options, hint. */
const DECISION_ROWS = 5
/** Cosmetic spacing rows: root/inner/options/hint margins + the focus spacer. */
const SPACING_ROWS = 5

export function ApprovalPanel({ approval, background = false, onDecide }: ApprovalPanelProps): React.ReactNode {
  const [focusIndex, setFocusIndex] = React.useState(0)
  // Hover highlight per decision row (mouse affordance; the click handler
  // below mirrors the keyboard Enter on the focused row).
  const [hoverIndex, setHoverIndex] = React.useState(-1)
  const { rows: terminalRows, columns } = useTerminalSize()

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onDecide('rejected')
      return
    }
    if (key.upArrow) {
      setFocusIndex(index => (index + OUTCOMES.length - 1) % OUTCOMES.length)
      return
    }
    if (key.downArrow) {
      setFocusIndex(index => (index + 1) % OUTCOMES.length)
      return
    }
    if (input === '1' || input === '2') {
      onDecide(OUTCOMES[Number(input) - 1]!)
      return
    }
    if (isPlainReturnInput(input, key)) {
      onDecide(OUTCOMES[focusIndex]!)
    }
  }, { isActive: true })

  const optionLabels = [t('approval-yes'), t('approval-no')]

  // Charge rows in priority order: decision surface, optional rows, cosmetic
  // spacing, then the elastic command/reason body.
  const reserved = DECISION_ROWS + (background ? 1 : 0)
  const panelBudget = Math.max(terminalRows - CHROME_ROWS_BELOW, reserved)
  let spacing = SPACING_ROWS
  let textBudget = panelBudget - reserved - spacing
  if (textBudget < 0) {
    spacing = 0
    textBudget = panelBudget - reserved
  }
  textBudget = Math.max(textBudget, 0)

  const externalText = approval.external === true
    ? `[external] ${t('approval-external-hint')}`
    : undefined
  // Widths mirror the render tree: root paddingLeft/Right(2+2) around the
  // reason, plus the command box's own paddingX(2+2). Wrapping is the only
  // O(text) work here and the panel re-renders with every Chat render (spinner
  // ticks while the approval is pending, hover, terminal resize), so the
  // wrapped lines are memoized on their inputs.
  const externalLines = React.useMemo(
    () => (externalText === undefined ? [] : wrapText(externalText, columns - 4)),
    [externalText, columns],
  )
  const commandLines = React.useMemo(
    () => (approval.command === undefined ? [] : wrapText(approval.command, columns - 8)),
    [approval.command, columns],
  )
  const reasonLines = React.useMemo(
    () => (approval.reason === undefined ? [] : wrapText(approval.reason, columns - 4)),
    [approval.reason, columns],
  )

  // The external-origin warning is a security notice and is charged in full;
  // the command (the artifact under review) takes what it needs next; the
  // reason folds into whatever remains.
  let available = Math.max(textBudget - externalLines.length, 0)
  const commandView = foldLines(commandLines, available)
  available = Math.max(available - foldedRows(commandView), 0)
  const reasonView = foldLines(reasonLines, available)

  const foldNote = (total: number, hidden: number): string =>
    t('approval-folded', { total: String(total), hidden: String(hidden) })

  return (
    <Box flexDirection="column" marginTop={spacing > 0 ? 1 : 0} paddingLeft={2} paddingRight={2} width="100%">
      <Divider color="permission" title={t('approval-waiting', { tool: approval.toolName })} />
      <Box flexDirection="column" marginTop={spacing > 0 ? 1 : 0}>
        {background && (
          <Text color="warning">
            {t('approval-background-agent', { id: approval.agentId.slice(0, 8) })}
          </Text>
        )}
        {externalText !== undefined && (
          <Text color="warning" wrap="wrap">{externalText}</Text>
        )}
        <FoldedBody view={commandView} total={commandLines.length} note={foldNote} paddingX={2} />
        <FoldedBody view={reasonView} total={reasonLines.length} note={foldNote} />
        <Text dimColor>{t('approval-proceed')}</Text>
      </Box>
      <Box flexDirection="column" marginTop={spacing > 0 ? 1 : 0} flexShrink={0}>
        {optionLabels.map((label, index) => {
          const focused = index === focusIndex
          const hovered = index === hoverIndex
          return (
            <Box
              key={label}
              flexDirection="row"
              marginTop={focused && spacing > 0 ? 1 : 0}
              onClick={() => onDecide(OUTCOMES[index]!)}
              onMouseEnter={() => setHoverIndex(index)}
              onMouseLeave={() => setHoverIndex(current => (current === index ? -1 : current))}
              backgroundColor={hovered && !focused ? 'userMessageBackgroundHover' : undefined}
            >
              <Box width={1} flexShrink={0}>
                <Text color={focused ? 'accent' : undefined} bold={focused}>
                  {focused ? POINTER : ' '}
                </Text>
              </Box>
              <Text bold={focused} color={focused ? 'accent' : undefined} wrap="wrap">
                {index + 1}. {label}
              </Text>
            </Box>
          )
        })}
      </Box>
      <Box marginTop={spacing > 0 ? 1 : 0} flexShrink={0}>
        <Text dimColor>{t('approval-hint')}</Text>
      </Box>
    </Box>
  )
}

/** The elastic command/reason body: leading rows plus a folded-count marker. */
function FoldedBody({ view, total, note, paddingX }: {
  view: FoldedLines
  total: number
  note: (total: number, hidden: number) => string
  paddingX?: number
}): React.ReactNode {
  if (view.shown.length === 0 && !view.marker) return null
  return (
    <Box flexDirection="column" flexShrink={1} paddingX={paddingX}>
      {view.shown.length > 0 && (
        <Text dimColor wrap="wrap">
          {view.shown.join('\n')}
        </Text>
      )}
      {view.marker && (
        <Text dimColor>{note(total, view.folded)}</Text>
      )}
    </Box>
  )
}
