import React from 'react'
import { Box, Text } from '../../ui.js'
import { t } from '../../i18n.js'
import {
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
  now,
}: {
  session: SessionSummary
  /** Columns available to the row, indentation included. */
  width: number
  /** 0 for a conversation, 1 for a sub-agent run under its parent. */
  depth: number
  focused: boolean
  /** Epoch ms used for every relative time in this render pass. */
  now: number
}): React.ReactNode {
  const indent = depth * 2
  // Two cells for the focus marker, plus the indent for a nested run.
  const body = Math.max(8, width - 2 - indent)
  const mark = kindMark(session.kind)

  const facts: string[] = [formatWhen(session.updatedAt, now)]
  if (session.branch !== undefined) facts.push(session.branch)
  const size = formatBytes(session.bytes)
  if (size !== undefined) facts.push(size)
  if (session.model !== undefined) facts.push(session.model)
  if (session.childCount > 0 && depth === 0) {
    facts.push(t('session-children', { n: session.childCount }))
  }

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box>
        <Text color={focused ? 'suggestion' : 'subtle'}>
          {`${' '.repeat(indent)}${focused ? '❯ ' : '  '}`}
        </Text>
        {mark !== undefined && <Text color={mark.color}>{`${mark.glyph} `}</Text>}
        <Text color={titleColor(session.title.source, focused)} bold={focused}>
          {truncateWidth(
            session.label ?? session.title.text,
            body - (mark === undefined ? 0 : 2),
          )}
        </Text>
      </Box>
      <Box>
        <Text dimColor>
          {`${' '.repeat(indent + 2)}${truncateWidth(facts.join(' · '), body)}`}
        </Text>
      </Box>
    </Box>
  )
}
