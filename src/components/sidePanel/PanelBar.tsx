/**
 * PanelBar: the 1-row tab strip on top of the side panel (design doc §6.1).
 *
 * Visual language:
 * - the ACTIVE panel is a capsule: ‹ Title ›, accent + bold — one glance
 *   tells you where you are;
 * - inactive panels collapse to their single-cell icon (or first letter),
 *   dim, with a status dot only when the panel has something to say
 *   (● unread/active, ! warning, × error — theme colors, never emoji);
 * - overflow is windowed, never a trail of dots: what does not fit
 *   becomes a dim +N on the right edge.
 *
 * The bar's width demand is content-independent (capsule titles truncate
 * to a fixed budget, icons are fixed cells) — a panel MUST never make the
 * column want to resize (design doc §16.6).
 */
import React from 'react'
import { Box, Text } from '../../ui.js'
import { stringWidth } from '../../ink/stringWidth.js'

export type PanelBadgeLevel = 'info' | 'warning' | 'error'

export interface PanelBarTab {
  readonly id: string
  readonly title: string
  /** Single-cell glyph; falls back to the title's first letter. */
  readonly icon?: string
  readonly badge?: { readonly level: PanelBadgeLevel; readonly unread: number } | null
}

export interface PanelBarProps {
  readonly tabs: readonly PanelBarTab[]
  readonly activeId: string | undefined
  readonly width: number
  /** Focus is in the right column: the bar brightens to match the divider. */
  readonly focused: boolean
  /** The ACTIVE panel has a fullscreen form (capabilities.fullscreen): the
   *  bar reserves the two trailing cells and draws the clickable ⤢. */
  readonly canExpand?: boolean
  /** Click/Enter on ⤢: switch the active panel to its fullscreen surface. */
  readonly onExpand?: () => void
  /** Click on a tab (icon or capsule): make that panel active. The host
   *  funnels this into the same openPanel() path the keyboard uses. */
  readonly onSelect?: (id: string) => void
}

/** Capsule title budget keeps one long plugin title from eating the bar. */
const ACTIVE_TITLE_MAX = 12

function badgeGlyph(level: PanelBadgeLevel): string {
  if (level === 'warning') return '!'
  if (level === 'error') return '×'
  return '●'
}

function badgeColor(level: PanelBadgeLevel): 'warning' | 'error' | 'accent' {
  if (level === 'warning') return 'warning'
  if (level === 'error') return 'error'
  return 'accent'
}

function truncateCells(text: string, maxCells: number): string {
  if (stringWidth(text) <= maxCells) return text
  let out = ''
  let cells = 0
  for (const char of text) {
    const w = stringWidth(char)
    if (cells + w > Math.max(1, maxCells - 1)) break
    out += char
    cells += w
  }
  return out + '…'
}

export function PanelBar({ tabs, activeId, width, focused, canExpand, onExpand, onSelect }: PanelBarProps): React.ReactNode {
  const [expandHovered, setExpandHovered] = React.useState(false)
  // Mouse feedback is per-tab: the bar is the only place where a click
  // switches WHAT the whole right column shows, so it must read as clickable
  // (hover brightens the glyph; the click path mirrors the ←/→ host keys).
  const [hoveredTab, setHoveredTab] = React.useState<string | null>(null)
  // The ⤢ affordance lives in the bar's own row (design: the panel column's
  // chrome is fixed-height — a panel must never make the column want to
  // resize). Reserve its two cells (one gap + one glyph) up front so tab
  // windowing and the +N marker stay honest at every width.
  const barWidth = Math.max(0, width - (canExpand === true ? 2 : 0))
  // Windowing: the active tab is always rendered; inactive tabs fit in
  // order around it and whatever remains folds into +N on the right.
  const active = tabs.find(tab => tab.id === activeId) ?? tabs[0]
  const segments: {
    readonly key: string
    readonly node: React.ReactNode
    readonly clickable: boolean
    readonly onHover: (next: boolean) => void
  }[] = []
  let hidden = 0
  let used = 0
  const moreCells = (n: number): number => stringWidth('+' + String(n)) + 1
  for (const tab of tabs) {
    const isActive = active !== undefined && tab.id === active.id
    // Budget per segment includes the 1-col gap rendered between them
    // (marginRight), otherwise the +N badge gets clipped at full bars.
    const cells = (isActive ? Math.min(stringWidth(tab.title), ACTIVE_TITLE_MAX) + 4 : 2) + (segments.length > 0 ? 1 : 0)
    // Reserve room for the eventual +N badge while tabs remain after this one.
    const remaining = tabs.length - segments.length - hidden - 1
    const reserve = remaining > 0 ? moreCells(remaining) : 0
    if (!isActive && used + cells + reserve > barWidth) {
      hidden += 1
      continue
    }
    used += cells
    const hovered = hoveredTab === tab.id
    segments.push({
      key: tab.id,
      node: isActive ? (
        // An active capsule is already accent while focused, so hover needs a
        // second channel to stay visible: underline (the glow alone would be a
        // no-op exactly where the pointer most often lands).
        <Text
          bold
          underline={hovered}
          color={hovered || focused ? 'accent' : 'inactive'}
          wrap="truncate-end"
        >
          {'‹ '}{truncateCells(tab.title, ACTIVE_TITLE_MAX)}{' ›'}
        </Text>
      ) : (
        <Text
          bold={hovered}
          dimColor={!hovered && tab.badge == null}
          color={tab.badge != null ? badgeColor(tab.badge.level) : hovered ? 'accent' : undefined}
        >
          {(tab.icon ?? tab.title.slice(0, 1)).slice(0, 1)}
          {tab.badge != null ? badgeGlyph(tab.badge.level) : ''}
        </Text>
      ),
      // Every tab is clickable: on an inactive one it switches the column,
      // on the active one it just takes the keyboard focus.
      clickable: onSelect !== undefined,
      onHover: (next: boolean) => setHoveredTab(previous => (next ? tab.id : previous === tab.id ? null : previous)),
    })
  }
  return (
    <Box height={1} flexShrink={0} paddingX={1} overflow="hidden">
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        {segments.map((segment, index) => (
          <Box
            key={segment.key}
            flexShrink={0}
            marginRight={index < segments.length - 1 ? 1 : 0}
            onMouseEnter={() => { segment.onHover(true) }}
            onMouseLeave={() => { segment.onHover(false) }}
            onClick={segment.clickable
              ? (event) => {
                // Mouse contract: without this the page-level "click the
                // column to focus it" fallback also fires on the same event.
                event.stopImmediatePropagation()
                onSelect?.(segment.key)
              }
              : undefined}
          >
            {segment.node}
          </Box>
        ))}
      </Box>
      {hidden > 0 && (
        <Text dimColor>{'+'}{hidden}</Text>
      )}
      {canExpand === true && (
        <Box
          flexShrink={0}
          marginLeft={1}
          onMouseEnter={() => { setExpandHovered(true) }}
          onMouseLeave={() => { setExpandHovered(false) }}
          onClick={(event) => {
            event.stopImmediatePropagation()
            onExpand?.()
          }}
        >
          <Text
            bold={expandHovered}
            color={expandHovered ? 'accent' : 'inactive'}
            /* Single-cell glyph + tooltip-free contract: the hint row below
               already documents the keys, and the glyph is the mouse path. */
          >
            {'⤢'}
          </Text>
        </Box>
      )}
    </Box>
  )
}
