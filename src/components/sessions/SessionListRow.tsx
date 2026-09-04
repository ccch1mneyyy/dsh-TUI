import React, { useState } from 'react'
import { Box, Text } from '../../ui.js'
import { t } from '../../i18n.js'
import type { ClickEvent } from '../../ink/events/click-event.js'
import type { ContextMenuEvent } from '../../ink/events/context-menu-event.js'
import { useTooltip } from '../Tooltip.js'
import {
  formatAbsolute,
  formatBytes,
  formatWhen,
  kindMark,
  titleColor,
  truncateWidth,
} from '../../sessions/format.js'
import type { SessionSummary } from '../../dsh-adapter/sessions/index.js'

/**
 * One session in the browser's list: a title line and a metadata line.
 *
 * Two lines rather than one because the two carry different jobs. The title
 * answers "is this the conversation I mean"; the metadata answers "which of
 * the three that look alike is it" — when it was, on what branch, how big,
 * under which model. Folding both onto one line makes the title compete with
 * facts nobody reads first, and on a narrow terminal the title is what loses.
 *
 * Widths are resolved here rather than delegated to flexbox: the row must
 * stay exactly two lines at every terminal width, and a row that wraps
 * destroys the alignment that lets the eye scan a list at all.
 */
export function SessionListRow({
  session,
  width,
  depth,
  focused,
  pinned,
  now,
  onClick,
  onContextMenu,
  onTogglePin,
}: {
  session: SessionSummary
  /** Columns available to the row, indentation included. */
  width: number
  /** 0 for a conversation, 1 for a sub-agent run under its parent. */
  depth: number
  focused: boolean
  /** Whether the user pinned this session to the top of the browser. */
  pinned: boolean
  /** Epoch ms used for every relative time in this render pass. */
  now: number
  /** 鼠标点击行（fullscreen）：恢复该会话（与 Enter 同路径）。 */
  onClick?(event: ClickEvent): void
  /** 鼠标右键（fullscreen）：在该行弹出操作菜单（打开/固定/重命名/删除）。 */
  onContextMenu?(event: ContextMenuEvent): void
  /** 点击行内 ★/☆（fullscreen）：切换固定状态，不冒泡成"打开会话"。 */
  onTogglePin?(): void
}): React.ReactNode {
  const indent = depth * 2
  // Two cells for the focus marker, plus the indent for a nested run.
  const body = Math.max(8, width - 2 - indent)
  const mark = kindMark(session.kind)
  const [hovered, setHovered] = useState(false)
  const pinTooltip = useTooltip(t(pinned ? 'resume-menu-unpin' : 'resume-menu-pin'))
  // Title hover tooltip: the row truncates a long title mid-word; when it
  // does, the float leads with the full title. The absolute timestamp and
  // cwd ride along in every case — the facts line shows only relative time
  // and never the working directory, so that pair is always new information
  // for telling look-alike sessions apart.
  const titleText = session.label ?? session.title.text
  const titleBudget = body - 2 - (mark === undefined ? 0 : 2)
  const shownTitle = truncateWidth(titleText, titleBudget)
  const titleTooltip = useTooltip(() => {
    const parts: string[] = []
    if (shownTitle !== titleText) parts.push(titleText)
    parts.push(formatAbsolute(session.updatedAt))
    if (session.cwd !== '') parts.push(session.cwd)
    return parts.join('\n')
  })

  const facts: string[] = [formatWhen(session.updatedAt, now)]
  if (session.branch !== undefined) facts.push(session.branch)
  const size = formatBytes(session.bytes)
  if (size !== undefined) facts.push(size)
  if (session.model !== undefined) facts.push(session.model)
  if (session.childCount > 0 && depth === 0) {
    facts.push(t('session-children', { n: session.childCount }))
  }

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseEnter={onClick !== undefined || onContextMenu !== undefined ? () => setHovered(true) : undefined}
      onMouseLeave={onClick !== undefined || onContextMenu !== undefined ? () => setHovered(false) : undefined}
      backgroundColor={focused || hovered ? 'userMessageBackgroundHover' : undefined}
    >
      <Box>
        <Text color={focused ? 'suggestion' : 'subtle'}>
          {`${' '.repeat(indent)}${focused ? '❯ ' : '  '}`}
        </Text>
        {/* The pin slot is a FIXED two-column cell on every row — ★ for a
            pinned session, ☆ otherwise — so the star is always visible and
            clickable and the title column never shifts when a pin toggles.
            Its width is charged to the title budget below, like the kind
            mark's. */}
        <Box
          {...pinTooltip}
          onClick={onTogglePin === undefined ? undefined : (event: ClickEvent): void => {
            // The star is a control on the row, not the row: a click here
            // toggles the pin and must never fall through to resume.
            event.stopImmediatePropagation()
            onTogglePin()
          }}
        >
          <Text color={pinned ? 'remember' : undefined} dimColor={!pinned}>{pinned ? '★ ' : '☆ '}</Text>
        </Box>
        {mark !== undefined && <Text color={mark.color}>{`${mark.glyph} `}</Text>}
        {/* The tooltip rides ONLY the title text, not the whole line: the
            pin slot's own tooltip must win over its two cells. */}
        <Box {...titleTooltip}>
          <Text color={titleColor(session.title.source, focused)} bold={focused}>
            {shownTitle}
          </Text>
        </Box>
      </Box>
      <Box>
        <Text dimColor>
          {`${' '.repeat(indent + 2)}${truncateWidth(facts.join(' · '), body)}`}
        </Text>
      </Box>
    </Box>
  )
}
