import React from 'react'
import { Box, Text, useInput, ScrollBox, type ScrollBoxHandle, useTerminalSize } from '../ui.js'
import { SpinnerGlyph } from './Spinner/SpinnerGlyph.js'
import { t } from '../i18n.js'
import { isPlainReturnInput } from '../utils/modifiers.js'

/**
 * `/recap` panel (pi-recap semantics): title line with the proposed
 * session title (apply via `a`/click), a scrollable one-line summary
 * body (error / summary / answering spinner), and a hint line. Owns the
 * keyboard while open, mirroring BtwPanel.
 */
export function RecapPanel({
  summary,
  title,
  error,
  streaming,
  titleApplied,
  onClose,
  onCopy,
  onApplyTitle,
}: {
  /** The one-line recap summary (streamed raw, then replaced on settle). */
  summary: string
  /** Proposed session title from the recap call, when the model offered one. */
  title?: string
  /** Human-readable failure reason. */
  error?: string
  /** True while the recap call is in flight. */
  streaming: boolean
  /** True once the proposed title was applied via renameSession. */
  titleApplied: boolean
  onClose: () => void
  onCopy: () => void
  onApplyTitle: () => void
}): React.ReactNode {
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const { rows } = useTerminalSize()
  // Spinner frame (80ms cadence, only while waiting for the first text).
  const [frame, setFrame] = React.useState(0)
  React.useEffect(() => {
    if (!streaming || summary !== '') return
    const interval = setInterval(() => setFrame(f => f + 1), 80)
    return () => clearInterval(interval)
  }, [streaming, summary])

  const canApply = title !== undefined && title !== '' && !titleApplied
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
    if (input === 'a' && !key.ctrl && canApply) {
      event.stopImmediatePropagation()
      onApplyTitle()
      return
    }
    // The overlay owns the keyboard while open: swallow everything else so
    // nothing leaks into the prompt input behind it.
    event.stopImmediatePropagation()
  })

  const settled = summary !== '' || error !== undefined
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="warning" bold>/recap </Text>
        {title !== undefined && (
          <Text dimColor>
            {t('recap-title-label')}:{' '}
            <Text color="suggestion">{title}</Text>
            {titleApplied ? (
              <Text color="success"> ✓ {t('recap-title-applied')}</Text>
            ) : (
              <Text color="success" bold>
                {' '}
                [{t('recap-apply-title')}]
              </Text>
            )}
          </Text>
        )}
      </Text>
      <Box flexDirection="column" maxHeight={Math.max(5, rows - 8)}>
        <Box marginLeft={2} flexDirection="column" flexGrow={1}>
          <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>
            {error !== undefined ? (
              <Text color="error">{error}</Text>
            ) : summary !== '' ? (
              <Text wrap="truncate-end">{summary}</Text>
            ) : (
              <Box>
                <SpinnerGlyph frame={frame} messageColor="warning" />
                <Text color="warning"> {t('recap-answering')}</Text>
              </Box>
            )}
          </ScrollBox>
        </Box>
      </Box>
      {/* 提示行可点击复制（与 c 键同路径） */}
      <Box onClick={settled ? onCopy : undefined}>
        <Text dimColor>
          {t('recap-hint', { apply: canApply ? ' · a ' + t('recap-apply-title') : '' })}
        </Text>
      </Box>
    </Box>
  )
}
