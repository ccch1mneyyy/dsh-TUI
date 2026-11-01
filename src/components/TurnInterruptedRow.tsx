import React from 'react'
import { Text } from '../ui.js'
import { getLang, subscribeLang, t } from '../i18n.js'

/**
 * The dim "interrupted" row shown when the user stops a turn.
 */
export function TurnInterruptedRow({ backendLabel }: { backendLabel?: string } = {}): React.ReactNode {
  React.useSyncExternalStore(subscribeLang, getLang)
  const askNext = backendLabel ? t('interrupted-ask-backend', { name: backendLabel }) : t('interrupted-ask-next')
  return (
    <>
      <Text dimColor>{t('interrupted-by-user')}</Text>
      <Text dimColor>{askNext}</Text>
    </>
  )
}
