import React from 'react'
import { marked, type Token, type Tokens } from 'marked'
import { Box, Text } from '../ui.js'
import { configureMarked, formatToken, stripPromptXMLTags } from '../cc/markdown.js'
import { getCliHighlightPromise, type CliHighlight } from '../cc/cliHighlight.js'
import { hashContent } from '../cc/hash.js'
import { MarkdownTable } from './MarkdownTable.js'

/**
 * Markdown renderer ported from Claude Code (the leak's `Markdown.tsx`):
 * marked lexer + ANSI formatter, tables rendered as flexbox-style bordered
 * components, async syntax highlighting via cli-highlight. The ANSI strings
 * render inside raw `Text` (the ported Ink core preserves ANSI in children;
 * the fork's `Ansi` span parser drops SGR 1 bold).
 */

type Props = {
  children: string
  /** When true, render all text content as dim */
  dimColor?: boolean
}

// Module-level token cache — marked.lexer is the hot cost on remounts.
// Messages are immutable; same content → same tokens.
//
// Bounds: entry count alone was not enough. Token.raw/text values are
// slices of the lexed input, so each entry pins its entire input string;
// during streaming the input grows every frame, and the LRU kept 500
// near-final snapshots ≈ 500 × message size resident (~500MB for a 1MB
// message). A character budget caps retained bytes; oversized contents
// skip the cache entirely (they are re-lexed on remount — rare, and
// cheaper than the retention).
const TOKEN_CACHE_MAX = 200
const TOKEN_CACHE_MAX_CHARS = 200_000
const TOKEN_CACHE_MAX_CONTENT = 20_000
const tokenCache = new Map<string, Token[]>()
let tokenCacheChars = 0

// Characters that indicate markdown syntax. If none are present, skip the
// ~3ms marked.lexer call entirely — render as a single paragraph.
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /
function hasMarkdownSyntax(s: string): boolean {
  return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s)
}

function cachedLexer(content: string): Token[] {
  // Fast path: plain text with no markdown syntax → single paragraph token.
  if (!hasMarkdownSyntax(content)) {
    return [
      {
        type: 'paragraph',
        raw: content,
        text: content,
        tokens: [{ type: 'text', raw: content, text: content }],
      } as Token,
    ]
  }
  const key = hashContent(content)
  const hit = tokenCache.get(key)
  if (hit) {
    // Promote to MRU
    tokenCache.delete(key)
    tokenCache.set(key, hit)
    return hit
  }
  const tokens = marked.lexer(content)
  if (content.length > TOKEN_CACHE_MAX_CONTENT) return tokens
  if (
    tokenCache.size >= TOKEN_CACHE_MAX ||
    tokenCacheChars + content.length > TOKEN_CACHE_MAX_CHARS
  ) {
    tokenCache.clear()
    tokenCacheChars = 0
  }
  tokenCache.set(key, tokens)
  tokenCacheChars += content.length
  return tokens
}

/**
 * Renders markdown content using a hybrid approach:
 * - Tables are rendered as bordered flexbox components
 * - Other content is rendered as ANSI strings via formatToken
 */
export function Markdown({ children, dimColor = false }: Props): React.ReactNode {
  const [highlight, setHighlight] = React.useState<CliHighlight | null>(null)

  React.useEffect(() => {
    let alive = true
    void getCliHighlightPromise().then(loaded => {
      if (alive) setHighlight(loaded)
    })
    return () => {
      alive = false
    }
  }, [])

  configureMarked()

  const elements = React.useMemo(() => {
    const tokens = cachedLexer(stripPromptXMLTags(children))
    const elements: React.ReactNode[] = []
    let nonTableContent = ''

    function flushNonTableContent(): void {
      if (nonTableContent) {
        elements.push(
          <Text key={elements.length} dimColor={dimColor}>
            {nonTableContent.trim()}
          </Text>,
        )
        nonTableContent = ''
      }
    }

    for (const token of tokens) {
      if (token.type === 'table') {
        flushNonTableContent()
        elements.push(
          <MarkdownTable
            key={elements.length}
            token={token as Tokens.Table}
            highlight={highlight}
          />,
        )
      } else {
        nonTableContent += formatToken(token, 0, null, null, highlight)
      }
    }

    flushNonTableContent()
    return elements
  }, [children, dimColor, highlight])

  return (
    <Box flexDirection="column" gap={1}>
      {elements}
    </Box>
  )
}
