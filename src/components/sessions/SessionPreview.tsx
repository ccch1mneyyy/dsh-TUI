import React from 'react'
import { Box, Text } from '../../ui.js'
import { t } from '../../i18n.js'
import { formatProject, formatWhen, kindLabel, truncateWidth, wrapWidth } from '../../sessions/format.js'
import type { PreviewEntry, SessionSummary } from '../../dsh-adapter/sessions/index.js'

/** Role marker and colour for a preview entry. */
const ROLE = {
  user: { glyph: '❯', color: 'suggestion' as const },
  assistant: { glyph: '✦', color: 'claude' as const },
}

/**
 * The preview pane: what this session actually says.
 *
 * It shows the END of the conversation, not the beginning, for two reasons.
 * The title already carries the beginning — it is usually the first prompt —
 * so repeating it would spend the pane on something the list already said. And
 * the question a person asks at this moment is "is this the one I was in the
 * middle of", which only the last exchange answers.
 *
 * It is also the reason the pane costs nothing: the tail of a log is exactly
 * what a bounded read already has in hand, so opening the preview on a 4 MB
 * session is the same amount of work as on a 40 KB one.
 */
export function SessionPreview({
  session,
  entries,
  loading,
  width,
  height,
  home,
  now,
}: {
  session: SessionSummary
  entries: readonly PreviewEntry[]
  loading: boolean
  width: number
  height: number
  home: string
  now: number
}): React.ReactNode {
  const body = Math.max(8, width - 2)

  // The pane is a fixed-height box, so its content is laid out as a flat list
  // of lines and cut to fit. Letting several adaptive paragraphs share a fixed
  // box lets them overlap once their natural height exceeds it.
  const lines: React.ReactNode[] = []
  let key = 0
  const push = (node: React.ReactNode): void => {
    lines.push(<Box key={key++} flexShrink={0}>{node}</Box>)
  }

  push(<Text color="remember" bold>{truncateWidth(session.title.text, body)}</Text>)
  push(
    <Text dimColor>
      {truncateWidth(
        [kindLabel(session.kind), formatProject(session.cwd, home)].join(' · '),
        body,
      )}
    </Text>,
  )
  push(
    <Text dimColor>
      {truncateWidth(
        t('session-preview-times', {
          created: formatWhen(session.createdAt, now),
          updated: formatWhen(session.updatedAt, now),
        }),
        body,
      )}
    </Text>,
  )
  push(<Text> </Text>)

  if (loading) {
    push(<Text dimColor italic>{t('session-preview-loading')}</Text>)
  } else if (entries.length === 0) {
    push(<Text dimColor italic>{t('session-preview-empty')}</Text>)
  } else {
    for (const entry of entries) {
      const role = ROLE[entry.role]
      const wrapped = wrapWidth(entry.text, body - 2)
      wrapped.forEach((line, index) => {
        push(
          <Text color={index === 0 ? role.color : undefined} dimColor={entry.role === 'assistant'}>
            {`${index === 0 ? `${role.glyph} ` : '  '}${line}`}
          </Text>,
        )
      })
      push(<Text> </Text>)
    }
  }

  // Keep the newest content: an overlong preview is cut at the TOP, so the
  // last thing said is always the last thing visible.
  const visible = lines.length > height ? lines.slice(lines.length - height) : lines

  return (
    <Box flexDirection="column" width={width} height={height} flexShrink={0} paddingLeft={2}>
      {visible}
    </Box>
  )
}
