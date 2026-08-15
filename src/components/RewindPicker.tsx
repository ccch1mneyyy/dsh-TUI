import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import type { ChatRow } from '../channel.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { HintLine } from './design-system/HintLine.js'

/**
 * Double-Esc rewind picker (CC's "Double-tap esc to rewind the code and/or
 * conversation to a previous point in time"): lists the user's past messages
 * newest-first; selecting one and confirming rewinds the conversation to
 * that point (the message comes back into the input for re-editing).
 */
export function RewindPicker({
  rows,
  focusIndex,
  confirmRow,
}: {
  rows: readonly ChatRow[]
  focusIndex: number
  confirmRow: ChatRow | null
}): React.ReactNode {
  if (confirmRow !== null) {
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color="remember" bold>
              {t('rewind-confirm-title')}
            </Text>
          </Box>
          <ListItem isFocused={false} description={t('rewind-confirm-desc')}>
            {preview(confirmRow.text)}
          </ListItem>
          <Text dimColor italic>
            <HintLine text={t('hint-rewind-back')} />
          </Text>
        </Box>
      </Pane>
    )
  }

  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {t('rewind-title')}
          </Text>
          <Text dimColor>{t('rewind-subtitle')}</Text>
        </Box>
        {rows.length === 0 ? (
          <ListItem isFocused={false}>{t('rewind-empty')}</ListItem>
        ) : (
          rows.map((row, index) => (
            <ListItem
              key={row.id}
              isFocused={index === focusIndex}
              description={index === 0 ? t('rewind-last-message') : undefined}
            >
              {preview(row.text)}
            </ListItem>
          ))
        )}
      </Box>
      <Text dimColor italic>
        <HintLine text={t('hint-select-exit')} />
      </Text>
    </Pane>
  )
}

/** One-line preview of a message (newlines flattened, capped). */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`
}
