import type { CliHighlight } from './cliHighlight.js'
import { SYNTAX_CLASS_TO_TOKEN, buildSyntaxTheme } from './syntaxTheme.js'
import type { Theme } from '../theme.js'

export type SyntaxRun = { readonly text: string; readonly color?: string }
export type SyntaxLines = readonly (readonly SyntaxRun[])[]
type SyntaxTheme = Theme | Record<string, (text: string) => string>

const ANSI16: Record<number, string> = {
  30: 'rgb(0,0,0)', 31: 'rgb(128,0,0)', 32: 'rgb(0,128,0)', 33: 'rgb(128,128,0)',
  34: 'rgb(0,0,128)', 35: 'rgb(128,0,128)', 36: 'rgb(0,128,128)', 37: 'rgb(192,192,192)',
  90: 'rgb(128,128,128)', 91: 'rgb(255,0,0)', 92: 'rgb(0,255,0)', 93: 'rgb(255,255,0)',
  94: 'rgb(0,0,255)', 95: 'rgb(255,0,255)', 96: 'rgb(0,255,255)', 97: 'rgb(255,255,255)',
}

/** Parse ANSI once, preserving active syntax colors over embedded newlines. */
export function parseAnsiRuns(text: string): SyntaxRun[] {
  const runs: SyntaxRun[] = []
  let color: string | undefined
  let rest = text
  // eslint-disable-next-line no-control-regex -- parsing SGR is intentional
  const sgr = /\x1b\[([0-9;]+)m/
  while (rest.length > 0) {
    const match = sgr.exec(rest)
    const chunk = match === null ? rest : rest.slice(0, match.index)
    if (chunk !== '') runs.push(color === undefined ? { text: chunk } : { text: chunk, color })
    if (match === null) break
    const codes = match[1]!.split(';').map(Number)
    if (codes.includes(0) || codes.includes(39)) color = undefined
    else if (codes[0] === 38 && codes[1] === 2 && codes.length >= 5) color = `rgb(${codes[2]},${codes[3]},${codes[4]})`
    else if (codes[0] === 38 && codes[1] === 5 && codes.length >= 3) color = `ansi256(${codes[2]})`
    else if (codes.length === 1 && ANSI16[codes[0]!] !== undefined) color = ANSI16[codes[0]!]
    rest = rest.slice(match.index + match[0].length)
  }
  return runs
}

export function splitRunsToLines(runs: readonly SyntaxRun[]): SyntaxLines {
  const lines: SyntaxRun[][] = [[]]
  for (const run of runs) {
    const parts = run.text.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([])
      if (parts[i] !== '') lines[lines.length - 1]!.push(run.color === undefined ? { text: parts[i]! } : { text: parts[i]!, color: run.color })
    }
  }
  return lines
}

const syntaxCache = new Map<string, SyntaxLines>()
const SYNTAX_CACHE_MAX = 64

/** Highlight complete text, then split it; unsupported or failed languages are plain. */
export function highlightLines(
  text: string,
  language: string | undefined,
  highlighter: CliHighlight | null,
  theme: SyntaxTheme | undefined,
  themeSig: string,
): SyntaxLines | undefined {
  if (highlighter === null || theme === undefined || language === undefined || text === '' || !highlighter.supportsLanguage(language)) return undefined
  const key = `${themeSig}\u0000${language}\u0000${text}`
  const cached = syntaxCache.get(key)
  if (cached !== undefined) return cached
  try {
    const themeOption = 'syntaxKeyword' in theme
      ? buildSyntaxTheme(theme as Theme)
      : theme
    const highlighted = highlighter.highlight(text, { language, theme: themeOption })
    const lines = splitRunsToLines(parseAnsiRuns(highlighted))
    if (syntaxCache.size >= SYNTAX_CACHE_MAX) {
      const first = syntaxCache.keys().next().value
      if (first !== undefined) syntaxCache.delete(first)
    }
    syntaxCache.set(key, lines)
    return lines
  } catch {
    return undefined
  }
}

export function syntaxThemeSignature(theme: Theme): string {
  const palette = theme as unknown as Record<string, string>
  return Object.values(SYNTAX_CLASS_TO_TOKEN).map(key => palette[key] ?? '').join('|')
}
