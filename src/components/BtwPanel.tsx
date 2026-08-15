import React from 'react'
import { Box, Text, useInput, ScrollBox, type ScrollBoxHandle, useTerminalSize } from '../ui.js'
import { Markdown } from './Markdown.js'
import { SpinnerGlyph } from './Spinner/SpinnerGlyph.js'
import { t } from '../i18n.js'
import { isPlainReturnInput } from '../utils/modifiers.js'

/**
 * /btw side-question panel (CC's btw.tsx, inline-pane form like the local
 * pickers): title line with the question, a scrollable answer body (error /
 * markdown answer / answering spinner), and a hint line. Owns the keyboard
 * while open — every key it sees is consumed here.
 */
export function BtwPanel({
  question,
  answer,
  error,
  streaming,
  onClose,
  onCopy,
}: {
  question: string
  answer: string
  error?: string
  streaming: boolean
  onClose: () => void
  onCopy: () => void
}): React.ReactNode {
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const { rows } = useTerminalSize()
  // Spinner frame (80ms cadence, only while waiting for the first text).
  const [frame, setFrame] = React.useState(0)
  React.useEffect(() => {
    if (!streaming || answer !== '') return
    const interval = setInterval(() => setFrame(f => f + 1), 80)
    return () => clearInterval(interval)
  }, [streaming, answer])

  useInput((input, key, event) => {
    if (key.escape || isPlainReturnInput(input, key) || input === ' ') {
      event.stopImmediatePropagation()
      onClose()
      return
    }
    if (key.upArrow || key.downArrow) {
      scrollRef.current?.scrollBy(key.upArrow ? -3 : 3)
      event.stopImmediatePropagation()
      return
    }
    if (input === 'c' && !key.ctrl) {
      event.stopImmediatePropagation()
      onCopy()
      return
    }
    // The overlay owns the keyboard while open: swallow everything else so
    // nothing leaks into the prompt input behind it.
    event.stopImmediatePropagation()
  })

  const settled = answer !== '' || error !== undefined
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="warning" bold>/btw </Text>
        <Text dimColor>{question}</Text>
      </Text>
      <Box flexDirection="column" maxHeight={Math.max(5, rows - 8)}>
        <Box marginLeft={2} flexDirection="column" flexGrow={1}>
          <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>
            {error !== undefined ? (
              <Text color="error">{error}</Text>
            ) : answer !== '' ? (
              <Markdown cacheTokens={false}>{answer}</Markdown>
            ) : (
              <Box>
                <SpinnerGlyph frame={frame} messageColor="warning" />
                <Text color="warning"> {t('btw-answering')}</Text>
              </Box>
            )}
          </ScrollBox>
        </Box>
      </Box>
      <Text dimColor>
        {settled ? t('btw-hint-done') : streaming ? t('btw-hint-loading') : t('btw-hint-done')}
      </Text>
    </Box>
  )
}
