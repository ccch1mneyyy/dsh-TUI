import React from 'react'
import { Text } from '../ui.js'
import type { Color } from '../ink/styles.js'
import { getCliHighlightPromise, type CliHighlight } from '../terminal-utils/cliHighlight.js'
import { highlightLines, syntaxThemeSignature, type SyntaxLines } from '../terminal-utils/syntaxRuns.js'
import { getTheme } from '../theme.js'
import { useTheme } from './design-system/ThemeProvider.js'

type Props = {
  readonly text: string
  readonly language?: string
  /** Complete payload used for lexing; text is the visible line. */
  readonly sourceText?: string
  readonly lineIndex?: number
  readonly color?: Color
  readonly dimColor?: boolean
}

/** Async nested Text renderer. Lexes the complete payload before splitting. */
export function SyntaxText({ text, language, sourceText = text, lineIndex = 0, color, dimColor }: Props): React.ReactNode {
  const [highlighter, setHighlighter] = React.useState<CliHighlight | null>(null)
  const [themeName] = useTheme()
  React.useEffect(() => {
    let mounted = true
    void getCliHighlightPromise().then(value => { if (mounted) setHighlighter(value) })
    return () => { mounted = false }
  }, [])
  const theme = React.useMemo(() => getTheme(themeName), [themeName])
  const themeSig = React.useMemo(() => syntaxThemeSignature(theme), [theme])
  const syntax: SyntaxLines | undefined = React.useMemo(
    () => highlightLines(sourceText, language, highlighter, theme, themeSig),
    [sourceText, language, highlighter, theme, themeSig],
  )
  const runs = syntax?.[lineIndex]
  if (runs === undefined || color !== undefined || dimColor) {
    return <Text color={color} dimColor={dimColor}>{text === '' ? ' ' : text}</Text>
  }
  let remaining = text.length
  const visibleRuns = runs.flatMap(run => {
    if (remaining <= 0) return []
    const visible = run.text.slice(0, remaining)
    remaining -= visible.length
    return visible === '' ? [] : [{ ...run, text: visible }]
  })
  return (
    <Text>
      {visibleRuns.length === 0 ? text : visibleRuns.map((run, index) => (
        <Text key={index} color={run.color as Color | undefined}>{run.text}</Text>
      ))}
    </Text>
  )
}
