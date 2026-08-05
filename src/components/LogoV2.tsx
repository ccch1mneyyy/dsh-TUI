import React from 'react'
import { Box, Text, useAnimationFrame, useTerminalSize } from '../ui.js'
import { getTheme } from '../theme.js'
import { useTheme } from './design-system/ThemeProvider.js'
import { parseRGB } from './Spinner/spinnerUtils.js'
import { renderBigText } from './bigfont.js'
import { BRAND, FLASH, ICE, PALE, sweep, type Rgb } from './shimmer.js'
import { WhaleArt } from './Whale.js'

const VERSION = '0.1.0'

/** Below this width the whale hides and the header goes text-only. */
const WHALE_MIN_COLUMNS = 64

/** `max` → `Max` (effort levels arrive lower-case from the adapter). */
function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1)
}

/**
 * The header splash: the DeepSeek pixel whale on the left, and next to it
 * the wordmark (`✦ dsh-cc` with a shimmer sweep + version), the `DEEPSEEK
 * HARNESS` tagline in a 5-row block font (brand-blue → ice gradient with a
 * white flowing highlight), the active model and reasoning effort, the
 * session working directory, and the startup tip. Below the block sits the
 * `探索未至之境！` welcome line in ice blue with a white sweep. Narrow
 * terminals drop the whale and keep the text column.
 */
export function LogoV2({
  model,
  effort,
  cwd,
}: {
  model: string
  effort?: string | undefined
  cwd: string
}): React.ReactNode {
  const [ref, time] = useAnimationFrame(200)
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const { columns } = useTerminalSize()

  const wordmarkRGB = parseRGB(theme.claude) ?? BRAND
  const wordmarkShimmerRGB = parseRGB(theme.claudeShimmer) ?? ICE
  const taglineRGB = parseRGB(theme.claudeBlue_FOR_SYSTEM_SPINNER) ?? ICE

  const showWhale = columns >= WHALE_MIN_COLUMNS
  const bigDeepSeek = renderBigText('DEEPSEEK', time, wordmarkRGB, taglineRGB, FLASH)
  const bigHarness = renderBigText('HARNESS', time, taglineRGB, PALE, FLASH)

  return (
    <Box ref={ref} flexDirection="column" marginTop={1}>
      <Box flexDirection="row" gap={2} width="100%" alignItems="center">
        {showWhale && <WhaleArt />}
        <Box flexDirection="column" flexShrink={1}>
          <Text wrap="truncate-end">
            {sweep('✦ dsh-cc', time, wordmarkRGB, wordmarkShimmerRGB)}
            <Text dimColor>{'  v' + VERSION}</Text>
          </Text>
          {bigDeepSeek.map((row, index) => (
            <Text key={`ds-${index}`} wrap="truncate-end">
              {row}
            </Text>
          ))}
          {bigHarness.map((row, index) => (
            <Text key={`h-${index}`} wrap="truncate-end">
              {row}
            </Text>
          ))}
          <Text wrap="truncate-end">
            <Text color="claude" bold>
              {model}
            </Text>
            {effort !== undefined && <Text dimColor>{' · ' + capitalize(effort) + ' effort'}</Text>}
          </Text>
          <Text dimColor wrap="truncate-end">
            {cwd}
          </Text>
          <Text wrap="truncate-end">
            <Text color="claude" bold>
              Tip:
            </Text>
            <Text color="claudeBlue_FOR_SYSTEM_SPINNER"> /model</Text>
            <Text dimColor> 切换模型 · </Text>
            <Text color="claudeBlue_FOR_SYSTEM_SPINNER">/help</Text>
            <Text dimColor> 查看命令 · </Text>
            <Text color="claudeBlue_FOR_SYSTEM_SPINNER">Tab</Text>
            <Text dimColor> 自动补全</Text>
          </Text>
        </Box>
      </Box>
      <Box marginTop={1} paddingLeft={2}>
        <Text>{sweep('探索未至之境！', time, taglineRGB, FLASH)}</Text>
      </Box>
    </Box>
  )
}
