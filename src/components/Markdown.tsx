import React from 'react'
import { marked, type Token, type Tokens } from 'marked'
import { Box, Text } from '../ui.js'
import type { TextDecoration } from '../ink/styles.js'
import { appendBlockText, configureMarked, formatToken, stripPromptXMLTags } from '../terminal-utils/markdown.js'
import { getCliHighlightPromise, type CliHighlight } from '../terminal-utils/cliHighlight.js'
import { isMermaidLang } from '../terminal-utils/mermaid.js'
import { isMathBlockToken, isMathToken } from '../terminal-utils/math.js'
import { getMathRendering, subscribeMathRendering } from '../tuiDisplayPrefs.js'
import { MarkdownTable } from './MarkdownTable.js'
import { CodeBlockFrame } from './CodeBlockFrame.js'
import { MermaidDiagram } from './MermaidDiagram.js'
import { InlineMathParagraph } from './InlineMathParagraph.js'
import { MathBlock } from './MathBlock.js'

/**
 * Markdown 渲染组件：marked 分词 + ANSI 格式化。
 *
 * 表格 token 交给 MarkdownTable 渲染为带边框的 flexbox 布局，mermaid
 * 代码块交给 MermaidDiagram 画成 box-drawing 图，`$$` 公式块交给
 * MathBlock 排成多行 Unicode（三者都需要终端宽度，所以是独立节点而不是
 * ANSI 字符串）；行内公式在 formatToken 里转成单行 Unicode；
 * 其余块级内容由 formatToken 转成 ANSI 字符串，按块边界分批放进
 * Text（只去整段首尾空白）。代码块高亮由 cli-highlight 异步提供，
 * 加载完成后自动触发一次重渲染。无 markdown 语法的纯文本走快速
 * 路径，直接合成段落 token，省掉 lexer 调用。
 */

type Props = {
  children: string
  /** 为 true 时全部文本内容以 dim 样式呈现 */
  dimColor?: boolean
  /** 为 false 时跳过 token 缓存（流式尾部的内容逐帧变化，缓存必然失效） */
  cacheTokens?: boolean
  /**
   * Whether paragraphs may show inline math as images (`mathRendering:
   * image`). Streaming text passes false: a paragraph switching to images
   * mid-stream would re-wrap under the reader; the settled message switches.
   */
  inlineMathImages?: boolean
}

// ---- token 缓存 ----
//
// marked.lexer 在组件重挂载时是最贵的开销；消息内容不可变，相同文本
// 必然产出相同 token，因此以原文为 key 缓存。
//
// 容量控制不能只看条数：Token 的 raw/text 字段是输入字符串的切片，
// 会钉住整段输入常驻内存；流式渲染时输入逐帧增长，若只按条数限流，
// LRU 会保留大量接近最终形态的快照（1MB 消息 ≈ 500 条 × 1MB ≈
// 500MB）。这里用字符预算限制保留量，超长内容干脆不缓存（重挂载时
// 重跑 lexer，极少发生且远比常驻便宜）。
/**
 * Typed hang decoration for the ANSI text runs (rendering-upgrade design
 * §2, the batch-D leftover fix): a terminal-wrapped continuation of a
 * line hangs under that line's own leading structure - quote rails repeat
 * as glyphs, list markers / checkboxes / indentation become spaces -
 * instead of falling at column 0. Hard rows are untouched. One frozen
 * identity: the style diff and the measure/paint caches key on it by
 * reference, so every text run shares this exact object.
 */
const HANG_DECORATION: TextDecoration = { hang: true }

const TOKEN_CACHE_CAPACITY = 200
const TOKEN_CACHE_CHAR_BUDGET = 200_000
const TOKEN_CACHE_MAX_SOURCE_LENGTH = 20_000
const TEXT_BLOCK_BUDGET = 8192
const tokenCache = new Map<string, Token[]>()
let tokenCacheChars = 0

// 语法探针：全文都没有结构标记时才跳过 lexer，不能仅凭纯文本前缀
// 忽略后面的公式或 Markdown。`$` 与 `\` 覆盖 LaTeX 公式定界符。
const MD_SYNTAX_MARKERS = /[#*`|[>\-_~$\\]|\n\n|^\d+\. |\n\d+\. /

function looksLikePlainText(s: string): boolean {
  return !MD_SYNTAX_MARKERS.test(s)
}

function lexWithCache(content: string, allowCache: boolean): Token[] {
  // 快速路径：纯文本直接合成单个段落 token，不触碰 lexer。
  if (looksLikePlainText(content)) {
    return [
      {
        type: 'paragraph',
        raw: content,
        text: content,
        tokens: [{ type: 'text', raw: content, text: content }],
      },
    ]
  }
  if (!allowCache) return marked.lexer(content)

  // 直接用内容字符串做 key：V8 在字符串头缓存哈希，首次插入后 Map
  // 查找无需再算哈希，也比 sha256 少一次摘要分配与碰撞风险。
  const hit = tokenCache.get(content)
  if (hit) {
    tokenCache.delete(content) // 提升为最近使用
    tokenCache.set(content, hit)
    return hit
  }

  const tokens = marked.lexer(content)
  if (content.length > TOKEN_CACHE_MAX_SOURCE_LENGTH) return tokens

  // Evict oldest entries (Map preserves insertion order) until both the
  // count and char budgets fit. The previous full clear() nuked the whole
  // cache every time a long session crossed 200 blocks — every subsequent
  // row remount then re-ran the lexer (scroll-through-a-long-session
  // stutter); evicting only what the newcomer displaces keeps the working
  // set warm.
  while (
    tokenCache.size >= TOKEN_CACHE_CAPACITY ||
    tokenCacheChars + content.length > TOKEN_CACHE_CHAR_BUDGET
  ) {
    const oldest = tokenCache.keys().next().value
    if (oldest === undefined) break
    tokenCache.delete(oldest)
    tokenCacheChars -= oldest.length
  }
  tokenCache.set(content, tokens)
  tokenCacheChars += content.length
  return tokens
}

/**
 * Tokens that render as their own layout node (a width-aware component)
 * instead of joining the ANSI text run. StreamingMarkdown consults the same
 * predicate: a standalone node has a fixed one-row gap to its neighbours
 * rather than the newline-derived spacing of text blocks. Fenced code
 * blocks join the group: the CodeBlockFrame needs structural width (rail +
 * padding) and per-visual-row gutter that an ANSI string cannot carry.
 */
export function isStandaloneToken(token: Token): boolean {
  return (
    token.type === 'table' ||
    token.type === 'code' ||
    isMermaidToken(token) ||
    isMathBlockToken(token)
  )
}

/** Whether a paragraph holds inline math anywhere in its inline tokens. */
function hasInlineMath(token: Token): boolean {
  for (const child of (token as { tokens?: Token[] }).tokens ?? []) {
    if (isMathToken(child) || hasInlineMath(child)) return true
  }
  return false
}

function isMermaidToken(token: Token): token is Tokens.Code {
  return token.type === 'code' && isMermaidLang((token as Tokens.Code).lang)
}

/**
 * 把 lexer 产出的 token 列表转成 React 节点序列：table、mermaid 与公式块
 * 独立渲染，其余 token 的 ANSI 文本按完整块分批拼接，只去整段首尾空白。
 */
function renderTokensToNodes(
  tokens: Token[],
  highlight: CliHighlight | null,
  dimColor: boolean,
  inlineMathImages: boolean,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let ansiText = ''
  let textParts: string[] = []
  let afterOwnNode = false

  const flushAnsiText = (): void => {
    if (!ansiText && textParts.length === 0) return
    if (textParts.length === 0) {
      nodes.push(<Text key={nodes.length} dimColor={dimColor} decoration={HANG_DECORATION}>{ansiText.trim()}</Text>)
    } else {
      textParts.push(ansiText)
      let first = 0
      let last = textParts.length - 1
      while (first < last && textParts[first]!.trimStart() === '') first++
      while (last > first && textParts[last]!.trimEnd() === '') last--
      textParts[first] = textParts[first]!.trimStart()
      textParts[last] = textParts[last]!.trimEnd()
      // Each internal boundary replaces exactly one source newline with a
      // column-child boundary. Only the whole text span trims outer space.
      nodes.push(
        <Box key={nodes.length} flexDirection="column">
          {textParts.slice(first, last + 1).map((part, index) => (
            <Text key={index} dimColor={dimColor} decoration={HANG_DECORATION}>{index + first < last ? part.slice(0, -1) : part}</Text>
          ))}
        </Box>,
      )
    }
    ansiText = ''
    textParts = []
  }

  for (const token of tokens) {
    const ownNodeBefore = afterOwnNode
    afterOwnNode = false
    if (token.type === 'table') {
      flushAnsiText()
      nodes.push(
        <MarkdownTable
          key={nodes.length}
          token={token as Tokens.Table}
          highlight={highlight}
        />,
      )
    } else if (inlineMathImages && token.type === 'paragraph' && hasInlineMath(token)) {
      flushAnsiText()
      nodes.push(<InlineMathParagraph key={nodes.length} token={token as Tokens.Paragraph} highlight={highlight} />)
      afterOwnNode = true
    } else if (ownNodeBefore && token.type === 'space') {
      // The blank line after a paragraph that became its own node is the
      // column gap now; as text it would flush as an empty node (an extra
      // gap row). In a text run the same newline is trimmed at the flush.
    } else if (isMathBlockToken(token)) {
      flushAnsiText()
      nodes.push(<MathBlock key={nodes.length} token={token} dimColor={dimColor} />)
    } else if (isMermaidToken(token)) {
      flushAnsiText()
      nodes.push(
        <MermaidDiagram
          key={nodes.length}
          token={token}
          highlight={highlight}
          dimColor={dimColor}
        />,
      )
    } else if (token.type === 'code') {
      // Top-level fences get the CodeBlockFrame (header/rail/padding);
      // the mermaid branch above keeps diagram fences routed to
      // MermaidDiagram (whose fallback re-enters the frame), and code
      // nested in lists/quotes keeps formatToken's ANSI path.
      flushAnsiText()
      nodes.push(
        <CodeBlockFrame key={nodes.length} token={token as Tokens.Code} highlight={highlight} dimColor={dimColor} />,
      )
    } else {
      // appendBlockText inserts the row break after the (newline-free) hr
      // divider when the next block does not open its own line.
      ansiText = appendBlockText(ansiText, formatToken(token, 0, null, null, highlight))
      // A top-level token boundary keeps inline formatting and code fences
      // intact while letting the painter cull finished offscreen text blocks.
      if (ansiText.length >= TEXT_BLOCK_BUDGET && ansiText.endsWith('\n')) {
        textParts.push(ansiText)
        ansiText = ''
      }
    }
  }

  flushAnsiText()
  return nodes
}

/**
 * 混合渲染 Markdown 内容：表格用带边框的 flexbox 组件，其余内容由
 * formatToken 生成 ANSI 字符串放入 Text。高亮对象异步就绪后自动刷新。
 *
 * memo by content: finished transcript blocks render with the SAME string
 * identity for the whole session (StreamingMarkdown keeps its stable prefix
 * identity-stable precisely to hit this); without the memo every parent
 * re-render re-ran the full token→ANSI→yoga pipeline for every settled
 * block — the dominant long-output stall (string-width via wrap-ansi, 60%+
 * of CPU in streaming profiles).
 */
function MarkdownImpl({ children, dimColor = false, cacheTokens = true, inlineMathImages = true }: Props): React.ReactNode {
  const [highlight, setHighlight] = React.useState<CliHighlight | null>(null)
  // Inline math is baked into the ANSI text, so the switch must invalidate
  // the memo below (MathBlock nodes subscribe on their own).
  const mathRendering = React.useSyncExternalStore(subscribeMathRendering, getMathRendering)

  React.useEffect(() => {
    let mounted = true
    void getCliHighlightPromise().then((loaded) => {
      if (mounted) setHighlight(loaded)
    })
    return () => {
      mounted = false
    }
  }, [])

  configureMarked()

  const renderedNodes = React.useMemo(() => {
    const source = stripPromptXMLTags(children)
    return renderTokensToNodes(
      lexWithCache(source, cacheTokens),
      highlight,
      dimColor,
      // Dimmed text (thinking) cannot dim an image, so it keeps Unicode.
      inlineMathImages && mathRendering === 'image' && !dimColor,
    )
  }, [children, dimColor, highlight, cacheTokens, mathRendering, inlineMathImages])

  return (
    <Box flexDirection="column" gap={1}>
      {renderedNodes}
    </Box>
  )
}

/**
 * Memoized Markdown: skips the whole token→ANSI→layout pipeline when the
 * content string is the same reference (see MarkdownImpl's doc comment).
 */
export const Markdown = React.memo(
  MarkdownImpl,
  (prev, next) =>
    prev.children === next.children &&
    prev.dimColor === next.dimColor &&
    prev.cacheTokens === next.cacheTokens &&
    prev.inlineMathImages === next.inlineMathImages,
)
