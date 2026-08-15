import React from 'react'
import Text from '../../ink/components/Text.js'

/**
 * Localized shortcut-hint line: renders a `t('hint-*')` string, with the
 * `**primary shortcut**` segment (the main action's key, wrapped in `**` in
 * the dict) in bold — the visual hierarchy KeyboardShortcutHint's `bold`
 * prop used to give. Wrap in `<Text dimColor italic>` for the common dim
 * styling, like the Byline it replaces.
 */
export function HintLine({ text }: { text: string }): React.ReactNode {
  const parts = text.split('**')
  if (parts.length < 3) return <>{text}</>
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? <Text key={index} bold>{part}</Text> : part,
      )}
    </>
  )
}
