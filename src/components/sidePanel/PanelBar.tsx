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

export function PanelBar({ tabs, activeId, width, focused }: PanelBarProps): React.ReactNode {
  // Windowing: the active tab is always rendered; inactive tabs fit in
  // order around it and whatever remains folds into +N on the right.
  const active = tabs.find(tab => tab.id === activeId) ?? tabs[0]
  const segments: { readonly key: string; readonly node: React.ReactNode }[] = []
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
    if (!isActive && used + cells + reserve > width) {
      hidden += 1
      continue
    }
    used += cells
    segments.push({
      key: tab.id,
      node: isActive ? (
        <Text bold color={focused ? 'accent' : 'inactive'} wrap="truncate-end">
          {'‹ '}{truncateCells(tab.title, ACTIVE_TITLE_MAX)}{' ›'}
        </Text>
      ) : (
        <Text dimColor={tab.badge == null} color={tab.badge != null ? badgeColor(tab.badge.level) : undefined}>
          {(tab.icon ?? tab.title.slice(0, 1)).slice(0, 1)}
          {tab.badge != null ? badgeGlyph(tab.badge.level) : ''}
        </Text>
      ),
    })
  }
  return (
    <Box height={1} flexShrink={0} paddingX={1} overflow="hidden">
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        {segments.map((segment, index) => (
          <Box key={segment.key} flexShrink={0} marginRight={index < segments.length - 1 ? 1 : 0}>
            {segment.node}
          </Box>
        ))}
      </Box>
      {hidden > 0 && (
        <Text dimColor>{'+'}{hidden}</Text>
      )}
    </Box>
  )
}
