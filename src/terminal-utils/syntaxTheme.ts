import chalk from 'chalk'
import type { Theme } from '../theme.js'

// --- syntax highlighting theme bridge ----------------------------------------
// Shared by SplitDiffView (diff panes) and the markdown renderer (fenced
// code blocks). Both feed cli-highlight's `theme` option so code colors come
// from the active dsh-tui theme instead of cli-highlight's own sparse
// default palette.

/** highlight.js token classes -> theme syntax tokens. `default` catches
 *  every unmapped class so cli-highlight's own yellow never leaks through
 *  (issue #250, P2-6). */
export const SYNTAX_CLASS_TO_TOKEN: Record<string, string> = {
  keyword: 'syntaxKeyword',
  built_in: 'syntaxKeyword',
  literal: 'syntaxKeyword',
  string: 'syntaxString',
  subst: 'syntaxString',
  quote: 'syntaxString',
  comment: 'syntaxComment',
  number: 'syntaxNumber',
  title: 'syntaxFunction',
  'title.function_': 'syntaxFunction',
  function: 'syntaxFunction',
  'title.class_': 'syntaxType',
  type: 'syntaxType',
  class: 'syntaxType',
  tag: 'syntaxType',
  name: 'syntaxType',
  attr: 'syntaxVariable',
  attribute: 'syntaxVariable',
  variable: 'syntaxVariable',
  'template-variable': 'syntaxVariable',
  params: 'syntaxVariable',
  operator: 'syntaxOperator',
  punctuation: 'syntaxPunctuation',
  meta: 'syntaxPunctuation',
  symbol: 'syntaxConstant',
  regexp: 'syntaxConstant',
  default: 'syntaxVariable',
}

/** chalk style for one raw theme value. Accepts every form the theme
 *  loader documents: #rgb, #rrggbb, #rrggbbaa (alpha stripped), rgb() with
 *  or without spaces, ansi256(n), ansi:name (issue #250, P2-5). */
export function chalkFromToken(token: string): (text: string) => string {
  let match = /^#([0-9a-fA-F]{3})$/.exec(token)
  if (match !== null) {
    const [r, g, b] = match[1]!.split('').map(c => parseInt(c + c, 16))
    return chalk.rgb(r!, g!, b!)
  }
  match = /^#([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/.exec(token)
  if (match !== null) return chalk.hex(`#${match[1]}`)
  match = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(token)
  if (match !== null) return chalk.rgb(Number(match[1]), Number(match[2]), Number(match[3]))
  match = /^ansi256\((\d+)\)$/.exec(token)
  if (match !== null) return chalk.ansi256(Number(match[1]))
  match = /^ansi:(\w+)$/.exec(token)
  if (match !== null) {
    const name = match[1] === 'blackBright' ? 'gray' : match[1]
    const style = (chalk as unknown as Record<string, ((text: string) => string) | undefined>)[name]
    if (style !== undefined) return style
  }
  return (text: string) => text
}

/** Build the cli-highlight `theme` option from an active theme palette. */
export function buildSyntaxTheme(
  theme: Theme,
): Record<string, (text: string) => string> {
  const palette = theme as unknown as Record<string, string>
  const out: Record<string, (text: string) => string> = {}
  for (const [tokenClass, tokenKey] of Object.entries(SYNTAX_CLASS_TO_TOKEN)) {
    const value = palette[tokenKey]
    if (value !== undefined) out[tokenClass] = chalkFromToken(value)
  }
  return out
}
