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
 */

import React from 'react'
import { t } from '../../i18n.js'
import { Box, Text, ScrollBox, useInput } from '../../ui.js'
import { INTERACTION_PANEL_PADDING, useInteractionViewport } from '../../hooks/useInteractionViewport.js'
import { isPlainReturnInput } from '../../utils/modifiers.js'
import { Divider } from '../design-system/Divider.js'
import { POINTER } from '../../terminal-utils/figures.js'
import type { ApprovalSnapshot } from '../../dsh-adapter/approvals.js'

export type ApprovalPanelProps = {
  /** The approval to render (from the ApprovalStore snapshot). */
  readonly approval: ApprovalSnapshot
  /** True when the asking agent is NOT the attached session — a background
   *  (agent view) session's ask, answered from the same single panel. */
  readonly background?: boolean
  /** Available rows, including panel spacing; hosts reserve their chrome. */
  readonly maxHeight?: number
  /** Restore the selection when the host moves a pending panel. */
  readonly initialFocusIndex?: number
  readonly onFocusChange?: (index: number) => void
  readonly onDecide: (outcome: 'allowed-once' | 'rejected') => void
}

const OUTCOMES = ['allowed-once', 'rejected'] as const

export function ApprovalPanel({ approval, background = false, maxHeight, initialFocusIndex = 0, onFocusChange, onDecide }: ApprovalPanelProps): React.ReactNode {
  const [focusIndex, setFocusIndex] = React.useState(initialFocusIndex === 1 ? 1 : 0)
  const focusRef = React.useRef(focusIndex)
  const moveFocus = (delta: number): void => {
    const index = (focusRef.current + delta + OUTCOMES.length) % OUTCOMES.length
    focusRef.current = index
    setFocusIndex(index)
    onFocusChange?.(index)
  }
  // Hover highlight per decision row (mouse affordance; the click handler
  // below mirrors the keyboard Enter on the focused row).
  const [hoverIndex, setHoverIndex] = React.useState(-1)
  const { panelRef, scrollRef, contentWidth, budget, lineCount, scrollInput } = useInteractionViewport(maxHeight)
  const optionLabels = [t('approval-yes'), t('approval-no')]
  const backgroundLabel = background
    ? t('approval-background-agent', { id: approval.agentId.slice(0, 8) })
    : undefined
  const externalLabel = approval.external === true ? `[external] ${t('approval-external-hint')}` : undefined
  const detailRows = (backgroundLabel === undefined ? 0 : lineCount(backgroundLabel))
    + (externalLabel === undefined ? 0 : lineCount(externalLabel))
    + (approval.command === undefined ? 0 : lineCount(approval.command, Math.max(1, contentWidth - 4)))
    + (approval.reason === undefined ? 0 : lineCount(approval.reason))
  const controlRows = 1 /* divider */ + lineCount(t('approval-proceed'))
    + optionLabels.reduce((sum, label, index) => sum + lineCount(`${index + 1}. ${label}`, Math.max(1, contentWidth - 1)), 0)
    + lineCount(t('approval-hint'))
  // Reserve the controls first, as Codex's selection popup does. On short
  // terminals drop decorative gaps before reducing the readable body.
  // https://github.com/openai/codex/blob/995138d71ac06b9df5996f049e69dea414ad9764/codex-rs/tui/src/bottom_pane/list_selection_view.rs
  const gap = budget >= controlRows + 8 ? 1 : 0
  const bodyBudget = Math.max(1, budget - controlRows - 5 * gap)
  const scrollable = detailRows > bodyBudget
  const detailHeight = Math.max(1, Math.min(detailRows,
    bodyBudget - (scrollable ? lineCount(t('approval-scroll-hint')) : 0)))

  useInput((input, key, event) => {
    if (scrollInput(key)) {
      event.stopImmediatePropagation()
      return
    }
    if (key.escape || (key.ctrl && input === 'c')) {
      onDecide('rejected')
      return
    }
    if (key.upArrow) {
      moveFocus(-1)
      return
    }
    if (key.downArrow) {
      moveFocus(1)
      return
    }
    if (input === '1' || input === '2') {
      onDecide(OUTCOMES[Number(input) - 1]!)
      return
    }
    if (isPlainReturnInput(input, key)) {
      onDecide(OUTCOMES[focusRef.current]!)
    }
  }, { isActive: true })

  return (
    <Box ref={panelRef} flexDirection="column" marginTop={gap} paddingX={INTERACTION_PANEL_PADDING} width="100%" flexShrink={0}>
      <Divider color="permission" title={t('approval-waiting', { tool: approval.toolName })} />
      <Box flexDirection="column" marginTop={gap} flexShrink={0}>
        {detailRows > 0 && (
          <>
            {scrollable && <Text dimColor wrap="wrap">{t('approval-scroll-hint')}</Text>}
            <ScrollBox ref={scrollRef} flexDirection="column" height={detailHeight} flexShrink={0}>
              {backgroundLabel !== undefined && <Text color="warning" wrap="wrap">{backgroundLabel}</Text>}
              {externalLabel !== undefined && <Text color="warning" wrap="wrap">{externalLabel}</Text>}
              {approval.command !== undefined && (
                <Box flexDirection="column" paddingX={2} flexShrink={0}>
                  <Text dimColor wrap="wrap">{approval.command}</Text>
                </Box>
              )}
              {approval.reason !== undefined && <Text dimColor wrap="wrap">{approval.reason}</Text>}
            </ScrollBox>
          </>
        )}
        <Text dimColor>{t('approval-proceed')}</Text>
      </Box>
      <Box flexDirection="column" marginTop={gap} flexShrink={0}>
        {optionLabels.map((label, index) => {
          const focused = index === focusIndex
          const hovered = index === hoverIndex
          return (
            <Box
              key={label}
              flexDirection="row"
              marginTop={focused ? gap : 0}
              flexShrink={0}
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
      <Box marginTop={gap} flexShrink={0}>
        <Text dimColor>{t('approval-hint')}</Text>
      </Box>
    </Box>
  )
}
