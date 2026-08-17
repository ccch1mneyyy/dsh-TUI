import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import type { LoadedContext } from '../dsh-adapter/channel.js'
import { summarizeLoadedContext } from '../utils/loaded-context.js'

/**
 * The startup context summary: a one-line inventory of what a
 * fresh conversation will load for the current agent (system prompt
 * sections, workspace instruction files, dynamic context, skill catalog,
 * tools). `/context` renders the existing details as a local report; the
 * summary itself disappears once the transcript has rows. Renders nothing
 * for an empty snapshot.
 * @param context - the channel's loaded-context snapshot.
 */
export function LoadedContextPanel({ context }: { context: LoadedContext }): React.ReactNode {
  const summary = summarizeLoadedContext(context)
  if (summary === '') return null
  return (
    <Box marginTop={1} marginBottom={1} paddingX={1}>
      <Text wrap="truncate">
        {t('context-loaded')} · {summary}
        <Text dimColor> · /context</Text>
      </Text>
    </Box>
  )
}
