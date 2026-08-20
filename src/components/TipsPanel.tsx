import React from 'react'
import { Box, Text, useInput, ScrollBox, type ScrollBoxHandle, useTerminalSize } from '../ui.js'
import { getLang, t } from '../i18n.js'
import { isPlainReturnInput } from '../utils/modifiers.js'
import { TIPS, TIP_GROUP_LABELS, type TipGroup } from '../tips.js'

const GROUP_ORDER: readonly TipGroup[] = ['keys', 'commands', 'workflow', 'display', 'pitfalls']

/**
 * `/tips` usage-tips panel (inline-pane form like the local pickers and the
 * /btw panel): grouped one-line tips on shortcuts, commands, workflow,
 * display, and gotchas. Owns the keyboard while open — every key it sees is
 * consumed here.
 *
 * The panel is a static list (no paging): the ScrollBox keeps it bounded,
 * and tips are intentionally one-liners so the whole pool stays scannable.
 */
export function TipsPanel({ onClose }: { onClose: () => void }): React.ReactNode {
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const { rows } = useTerminalSize()

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
    // The panel owns the keyboard while open: swallow everything else so
    // nothing leaks into the prompt input behind it.
    event.stopImmediatePropagation()
  })

  const lang = getLang()

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="warning" bold>/tips </Text>
        <Text dimColor>{t('tips-title')}</Text>
      </Text>
      <Box flexDirection="column" maxHeight={Math.max(5, rows - 8)}>
        <Box marginLeft={2} flexDirection="column" flexGrow={1}>
          <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>
            {GROUP_ORDER.map(group => (
              <Box key={group} flexDirection="column" marginBottom={1}>
                <Text bold color="claude">
                  {lang === 'zh' ? TIP_GROUP_LABELS[group].zh : TIP_GROUP_LABELS[group].en}
                </Text>
                {TIPS.filter(tip => tip.group === group).map(tip => (
                  <Text key={tip.id} dimColor>
                    {'  · '}
                    {lang === 'zh' ? tip.zh : tip.en}
                  </Text>
                ))}
              </Box>
            ))}
          </ScrollBox>
        </Box>
      </Box>
      <Text dimColor>{t('tips-hint')}</Text>
    </Box>
  )
}
