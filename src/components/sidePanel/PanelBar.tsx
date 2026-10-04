import React from 'react'
import { Box, Text } from '../../ui.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useTooltip } from '../Tooltip.js'

export type PanelBadgeLevel = 'info' | 'warning' | 'error'

export interface PanelBarTab {
  readonly id: string
  readonly title: string
  readonly badge?: { readonly level: PanelBadgeLevel; readonly unread: number } | null
}

export interface PanelBarProps {
  readonly tabs: readonly PanelBarTab[]
  readonly activeId: string | undefined
  readonly width: number
  readonly focused: boolean
  readonly canExpand?: boolean
  readonly onExpand?: () => void
  readonly onSelect?: (id: string) => void
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
    const width = stringWidth(char)
    if (cells + width > Math.max(1, maxCells - 1)) break
    out += char
    cells += width
  }
  return out + '…'
}

function ActiveTitle({ title, left, width, focused }: { title: string; left: number; width: number; focused: boolean }): React.ReactNode {
  const clipped = stringWidth(title) > width
  const tooltip = useTooltip(title)
  return (
    <Box position="absolute" left={left} top={0} width={width} height={1} justifyContent="center" overflow="hidden" {...(clipped ? tooltip : {})}>
      <Text bold color={focused ? 'accent' : 'inactive'} wrap="truncate-end">{truncateCells(title, width)}</Text>
    </Box>
  )
}

function PanelDot({ tab, left, width, focused, hovered, onHover, onSelect }: {
  tab: PanelBarTab
  left: number
  width: number
  focused: boolean
  hovered: boolean
  onHover: (id: string | null) => void
  onSelect?: (id: string) => void
}): React.ReactNode {
  const tooltip = useTooltip(tab.title)
  const unread = tab.badge?.unread ?? 0
  const label = (tab.badge == null ? '○' : '●') + (unread > 0 ? String(unread) : '')
  return (
    <Box
      position="absolute"
      left={left}
      top={0}
      width={width}
      height={1}
      flexShrink={0}
      justifyContent="center"
      {...tooltip}
      onMouseEnter={event => { tooltip.onMouseEnter(event); onHover(tab.id) }}
      onMouseLeave={() => { tooltip.onMouseLeave(); onHover(null) }}
      onClick={onSelect === undefined ? undefined : event => {
        event.stopImmediatePropagation()
        onSelect(tab.id)
      }}
    >
      <Text
        bold={hovered}
        dimColor={!hovered && tab.badge == null && !focused}
        color={tab.badge != null ? badgeColor(tab.badge.level) : hovered || focused ? 'accent' : undefined}
      >
        {label}
      </Text>
    </Box>
  )
}

export function PanelBar({ tabs, activeId, width, focused, canExpand, onExpand, onSelect }: PanelBarProps): React.ReactNode {
  const [expandHovered, setExpandHovered] = React.useState(false)
  const [hoveredTab, setHoveredTab] = React.useState<string | null>(null)
  const activeIndex = Math.max(0, tabs.findIndex(tab => tab.id === activeId))
  const active = tabs[activeIndex]
  const hasArrows = tabs.length > 1
  const contentWidth = Math.max(0, width - 2)
  const arrowWidth = hasArrows ? 1 : 0
  const expandWidth = canExpand === true ? 2 : 0
  const middleStart = arrowWidth
  const middleWidth = Math.max(0, contentWidth - arrowWidth * 2 - expandWidth)
  const dots: Array<{ readonly tab: PanelBarTab; readonly side: 'left' | 'right' }> = []
  for (let distance = 1; dots.length < tabs.length - 1; distance += 1) {
    dots.push({ tab: tabs[(activeIndex + distance) % tabs.length]!, side: 'right' })
    if (dots.length < tabs.length - 1) {
      dots.push({ tab: tabs[(activeIndex - distance + tabs.length) % tabs.length]!, side: 'left' })
    }
  }
  const dotWidth = Math.max(2, ...dots.map(dot => stringWidth((dot.tab.badge == null ? '○' : '●') + (dot.tab.badge !== undefined && dot.tab.badge !== null && dot.tab.badge.unread > 0 ? String(dot.tab.badge.unread) : ''))))
  const titleWidth = active === undefined
    ? 0
    : Math.max(6, Math.min(stringWidth(active.title), Math.max(6, middleWidth - dots.length * dotWidth)))
  const pitch = dots.length === 0 ? 0 : Math.max(2, Math.floor((middleWidth - titleWidth) / dots.length))
  const titleLeft = middleStart + Math.floor((middleWidth - titleWidth) / 2)
  let rightIndex = 0
  let leftIndex = 0
  const dotPositions = dots.map(dot => {
    const index = dot.side === 'right' ? rightIndex++ : leftIndex++
    return {
      ...dot,
      left: dot.side === 'right'
        ? titleLeft + titleWidth + index * pitch
        : titleLeft - (index + 1) * pitch,
    }
  })
  const changePanel = (delta: number): void => {
    if (active === undefined || tabs.length <= 1) return
    onSelect?.(tabs[(activeIndex + delta + tabs.length) % tabs.length]!.id)
  }
  return (
    <Box height={1} flexShrink={0} paddingX={1} overflow="hidden">
      <Box width={contentWidth} height={1} position="relative" overflow="hidden" flexShrink={0}>
        {active !== undefined && <ActiveTitle title={active.title} left={titleLeft} width={titleWidth} focused={focused} />}
        {dotPositions.map(dot => (
          <PanelDot
            key={dot.tab.id}
            tab={dot.tab}
            left={dot.left}
            width={pitch}
            focused={focused}
            hovered={hoveredTab === dot.tab.id}
            onHover={setHoveredTab}
            onSelect={onSelect}
          />
        ))}
        {hasArrows && (
          <>
            <Box
              position="absolute"
              left={0}
              top={0}
              width={1}
              height={1}
              justifyContent="center"
              onClick={event => { event.stopImmediatePropagation(); changePanel(-1) }}
            >
              <Text color={focused ? 'accent' : 'inactive'}>◀</Text>
            </Box>
            <Box
              position="absolute"
              left={contentWidth - expandWidth - 1}
              top={0}
              width={1}
              height={1}
              justifyContent="center"
              onClick={event => { event.stopImmediatePropagation(); changePanel(1) }}
            >
              <Text color={focused ? 'accent' : 'inactive'}>▶</Text>
            </Box>
          </>
        )}
        {canExpand === true && (
          <Box
            position="absolute"
            left={contentWidth - 1}
            top={0}
            width={1}
            height={1}
            onMouseEnter={() => { setExpandHovered(true) }}
            onMouseLeave={() => { setExpandHovered(false) }}
            onClick={event => { event.stopImmediatePropagation(); onExpand?.() }}
          >
            <Text bold={expandHovered} color={expandHovered || focused ? 'accent' : 'inactive'}>⤢</Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}
