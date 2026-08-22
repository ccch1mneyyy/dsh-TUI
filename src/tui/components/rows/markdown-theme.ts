/**
 * `MarkdownTheme` for the fork's `Markdown` component, mapped from the
 * active dsh theme (plan §1.3, WP-03).
 *
 * Every style function resolves its palette token through `getActiveTheme()`
 * at CALL time (Kimi's `createMarkdownTheme` pattern), so a theme switch is
 * honored by `invalidate()` alone — the theme object itself never goes stale.
 *
 * Code-block highlighting keeps the old lazy `cli-highlight` load: the first
 * `warmCodeHighlight()` call starts the dynamic import; while it is pending
 * (or if it fails) code blocks render plain, and once it resolves `onReady`
 * fires so the host can invalidate + repaint (the old React Markdown did the
 * same via a state update).
 */
import chalk from 'chalk'
import type { MarkdownTheme } from '../../public.js'
import { getActiveTheme } from '../../../theme.js'
import { getCliHighlightPromise, type CliHighlight } from '../../../cc/cliHighlight.js'
import { buildSyntaxTheme } from '../../../cc/syntaxTheme.js'
import { paint } from './style.js'

// The fork renders literal "### " markers for h3-h6 headings (h1/h2 have
// none). The prefix arrives already wrapped in bold SGR codes, so strip it
// after any leading ANSI sequences — otherwise h3+ reads like unparsed
// markdown (Kimi's pi-tui-theme does the same).
// eslint-disable-next-line no-control-regex -- intentionally matches the ESC byte that opens ANSI SGR sequences.
const HEADING_HASH_PREFIX = /^((?:\u001B\[[0-9;]*m)*)#{1,6}[ \t]+/

let highlighter: CliHighlight | null = null
let warmStarted = false

/** Start the shared lazy cli-highlight load; `onReady` fires once when the
 *  highlighter becomes usable (never on failure — plain rendering stands). */
export function warmCodeHighlight(onReady: () => void): void {
  if (warmStarted) return
  warmStarted = true
  void getCliHighlightPromise().then((loaded) => {
    highlighter = loaded
    if (loaded !== null) onReady()
  })
}

/** MarkdownTheme backed by the active dsh palette (see module header). */
export function createTranscriptMarkdownTheme(): MarkdownTheme {
  const theme = getActiveTheme
  return {
    heading: (text) => {
      // h3+ keep their fork-applied bold and lose only the hash markers;
      // h1/h2 get the mist brand blue (old dsh used `claude`/`permission`).
      if (HEADING_HASH_PREFIX.test(text)) return text.replace(HEADING_HASH_PREFIX, '$1')
      return paint(text, theme().claude)
    },
    link: (text) => text,
    linkUrl: (text) => chalk.dim(text),
    code: (text) => paint(text, theme().permission),
    codeBlock: (text) => text,
    codeBlockBorder: (text) => paint(text, theme().subtle),
    quote: (text) => text,
    quoteBorder: (text) => chalk.dim(text),
    hr: (text) => chalk.dim(text),
    listBullet: (text) => paint(text, theme().permission),
    bold: (text) => chalk.bold(text),
    italic: (text) => chalk.italic(text),
    strikethrough: (text) => chalk.strikethrough(text),
    underline: (text) => chalk.underline(text),
    highlightCode: (code, lang) => {
      if (highlighter === null) return code.split('\n')
      const language = lang !== undefined && highlighter.supportsLanguage(lang) ? lang : 'plaintext'
      try {
        return highlighter
          .highlight(code, { language, theme: buildSyntaxTheme(theme()) })
          .split('\n')
      } catch {
        return code.split('\n')
      }
    },
  }
}
