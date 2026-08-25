import React from 'react'
import { Box, Text, useInput, ScrollBox, type ScrollBoxHandle, useTerminalSize } from '../ui.js'
import { SpinnerGlyph } from './Spinner/SpinnerGlyph.js'
import { Pane } from './design-system/Pane.js'
import { t } from '../i18n.js'
import { isPlainReturnInput } from '../utils/modifiers.js'

/**
 * `/recap` panel (pi-recap semantics), in the picker/dialog visual
 * language: a permission-colored Pane with a title bar (会话回顾), a
 * scrollable summary body (error / summary / answering spinner), the
 * proposed session title row (apply via `a` or clicking the chip), and a
 * dim italic hint line (click to copy, same as `c`). Owns the keyboard
 * while open, mirroring BtwPanel.
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
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {t('recap-panel-title')}
          </Text>
          <Text dimColor> · {t('recap-panel-subtitle')}</Text>
        </Box>
        <Box flexDirection="column" maxHeight={Math.max(5, rows - 11)}>
          <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>
            {error !== undefined ? (
              <Text color="error">{error}</Text>
            ) : summary !== '' ? (
              <Text>{summary}</Text>
            ) : (
              <Box>
                <SpinnerGlyph frame={frame} messageColor="warning" />
                <Text color="warning"> {t('recap-answering')}</Text>
              </Box>
            )}
          </ScrollBox>
        </Box>
        {title !== undefined && (
          <Box flexDirection="row" marginTop={1}>
            <Text dimColor>{t('recap-title-label')}: </Text>
            <Text color="suggestion">{title}</Text>
            {titleApplied ? (
              <Text color="success"> ✓ {t('recap-title-applied')}</Text>
            ) : (
              <Box onClick={canApply ? onApplyTitle : undefined}>
                <Text color="success" bold>
                  {' '}
                  [{t('recap-apply-title')}]
                </Text>
              </Box>
            )}
          </Box>
        )}
        {/* 提示行可点击复制（与 c 键同路径） */}
        <Box onClick={settled ? onCopy : undefined}>
          <Text dimColor italic>
            {t('recap-hint', { apply: canApply ? ' · a ' + t('recap-apply-title') : '' })}
          </Text>
        </Box>
      </Box>
    </Pane>
  )
}
