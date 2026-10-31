import React from 'react'
import { Text } from '../ui.js'
import { getLang, subscribeLang, t } from '../i18n.js'

/**
 * The dim "interrupted" row shown when the user stops a turn, or when the
 * session's teardown did (`cause: 'disposed'`).
 */
export function TurnInterruptedRow({ backendLabel, cause }: { backendLabel?: string; cause?: 'disposed' } = {}): React.ReactNode {
  React.useSyncExternalStore(subscribeLang, getLang)
  if (cause === 'disposed') return <Text dimColor>{t('interrupted-session-disposed')}</Text>
  const askNext = backendLabel ? t('interrupted-ask-backend', { name: backendLabel }) : t('interrupted-ask-next')
  return (
    <>
      <Text dimColor>{t('interrupted-by-user')}</Text>
      <Text dimColor>{askNext}</Text>
    </>
  )
}
