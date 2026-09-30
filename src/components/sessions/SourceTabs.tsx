import React, { useState } from 'react'
import { Box, Text } from '../../ui.js'
import type { ClickEvent } from '../../ink/events/click-event.js'
import { stringWidth } from '../../ink/stringWidth.js'

/** One tab of the session screen's source strip. */
export interface SourceTab {
  readonly id: string
  readonly label: string
}

/** Which tabs the strip draws and which fold into the `+N` cell. */
export interface SourceTabsLayout {
  readonly shown: readonly SourceTab[]
  readonly hidden: readonly SourceTab[]
}

/** A tab cell is its label with one column of padding on each side. */
const cellWidth = (label: string): number => stringWidth(label) + 2

/**
 * Display width of a strip: its cells, the `│` after the leading DSH tab when
 * anything follows it, and the `+N` cell when tabs are folded.
 * @param shown - Tabs drawn in full; the first is the DSH tab when present.
 * @param hidden - How many tabs fold into `+N`.
 * @param leadId - Id of the tab the separator follows.
 * @returns Terminal cells the strip occupies.
 */
export function sourceTabsWidth(shown: readonly SourceTab[], hidden: number, leadId: string): number {
  let width = shown.reduce((sum, tab) => sum + cellWidth(tab.label), 0)
  if (hidden > 0) width += cellWidth(`+${hidden}`)
  if (shown[0]?.id === leadId && (shown.length > 1 || hidden > 0)) width += 1
  return width
}

/**
 * Fit the strip into `budget` cells.
 *
 * Tabs fold from the END (the strip is sorted by recency, so the oldest source
 * goes first) into one `+N` cell. The active tab never folds — a strip that
 * hid the tab you are on could not tell you where you are — and the leading
 * tab is the last to go after it.
 * @param tabs - Every tab, leading tab first.
 * @param active - Id of the active tab.
 * @param budget - Cells available to the strip.
 * @returns The tabs to draw and the tabs behind `+N`.
 */
export function layoutSourceTabs(tabs: readonly SourceTab[], active: string, budget: number): SourceTabsLayout {
  const leadId = tabs[0]?.id ?? ''
  for (let keep = tabs.length; keep >= 0; keep--) {
    const shown = tabs.filter((tab, index) => index < keep || tab.id === active)
    const hidden = tabs.filter(tab => !shown.includes(tab))
    if (sourceTabsWidth(shown, hidden.length, leadId) <= budget) return { shown, hidden }
  }
  // Not even the active tab and `+N` fit: draw them anyway and let the header
  // clip, since a missing active tab is worse than a clipped one.
  const shown = tabs.filter(tab => tab.id === active)
  return { shown, hidden: tabs.filter(tab => tab.id !== active) }
}

/**
 * The source strip in the session screen's header: `DSH │ Claude Code  Codex`.
 *
 * The active tab is a reverse block in the remember colour; the others are dim
 * until the pointer is over them. Every click stops propagation, because the
 * screen's root closes open menus on click and a tab click is not a click on
 * the background.
 */
export function SourceTabs({
  layout,
  active,
  leadId,
  onSelect,
  onOverflow,
}: {
  layout: SourceTabsLayout
  active: string
  /** Id of the tab the `│` separator follows. */
  leadId: string
  onSelect(id: string): void
  /** Click on `+N`: open the list of folded tabs at the pointer. */
  onOverflow(event: ClickEvent): void
}): React.ReactNode {
  return (
    <Box flexShrink={0} height={1} overflow="hidden">
      {layout.shown.map((tab, index) => (
        <React.Fragment key={tab.id}>
          <SourceTabCell
            label={tab.label}
            active={tab.id === active}
            onClick={(event: ClickEvent): void => {
              event.stopImmediatePropagation()
              onSelect(tab.id)
            }}
          />
          {index === 0 && tab.id === leadId && (layout.shown.length > 1 || layout.hidden.length > 0) && (
            <Text dimColor>{'│'}</Text>
          )}
        </React.Fragment>
      ))}
      {layout.hidden.length > 0 && (
        <SourceTabCell
          label={`+${layout.hidden.length}`}
          active={false}
          onClick={(event: ClickEvent): void => {
            event.stopImmediatePropagation()
            onOverflow(event)
          }}
        />
      )}
    </Box>
  )
}

function SourceTabCell({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick(event: ClickEvent): void
}): React.ReactNode {
  const [hovered, setHovered] = useState(false)
  return (
    <Box
      flexShrink={0}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {active
        ? <Text color="remember" bold inverse>{` ${label} `}</Text>
        : <Text dimColor={!hovered}>{` ${label} `}</Text>}
    </Box>
  )
}
