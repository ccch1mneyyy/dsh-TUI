import React from 'react'
import { Text } from '../ui.js'
import { t } from '../i18n.js'

/**
 * The dim "interrupted" row shown when the user stops a turn.
 */
export function TurnInterruptedRow(): React.ReactNode {
  return (
    <>
      <Text dimColor>{t('interrupted-by-user')}</Text>
      <Text dimColor>{t('interrupted-ask-next')}</Text>
    </>
  )
}
