import React from 'react'
import { LANGS, t, type Lang } from '../i18n.js'
import { Box, Text } from '../ui.js'
import { Pane } from './design-system/Pane.js'
import { Select } from './Select.js'
import { HintLine } from './design-system/HintLine.js'

/**
 * `/lang` en/zh picker: bare `/lang` opens this picker (the current language
 * marked) and Enter applies the choice through the same path as `/lang <id>`.
 */
export function LangPicker({
  focusIndex,
  currentLang,
  onPick,
}: {
  focusIndex: number
  currentLang: Lang
  /** Mouse pick (fullscreen): clicked row's absolute index (Chat applies
   *  the same code path as the keyboard Enter). */
  onPick?: (index: number) => void
}): React.ReactNode {
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {t('lang-picker-title')}
          </Text>
        </Box>
        <Select
          options={LANGS.map(lang => ({
            value: lang,
            label: lang === 'zh' ? '中文' : 'English',
            description: t(lang === 'zh' ? 'lang-zh-desc' : 'lang-en-desc'),
          }))}
          focusIndex={focusIndex}
          selectedValue={currentLang}
          onPick={onPick ? index => onPick(index) : undefined}
        />
        <Text dimColor italic>
          <HintLine text={t('hint-confirm-exit')} />
        </Text>
      </Box>
    </Pane>
  )
}
