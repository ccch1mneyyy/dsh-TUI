import React from 'react'
import { marked, type Token, type Tokens } from 'marked'
import { Box, Text } from '../ui.js'
import { configureMarked, formatToken, stripPromptXMLTags } from '../cc/markdown.js'
import { getCliHighlightPromise, type CliHighlight } from '../cc/cliHighlight.js'
import { MarkdownTable } from './MarkdownTable.js'

/**
 * Markdown 渲染组件：marked 分词 + ANSI 格式化。
 *
 * 表格 token 交给 MarkdownTable 渲染为带边框的 flexbox 布局；
 * 其余块级内容由 formatToken 转成 ANSI 字符串，合并后包进单个
 * Text（整段去首尾空白）。代码块高亮由 cli-highlight 异步提供，
 * 加载完成后自动触发一次重渲染。无 markdown 语法的纯文本走快速
 * 路径，直接合成段落 token，省掉 lexer 调用。
 */

type Props = {
  children: string
  /** 为 true 时全部文本内容以 dim 样式呈现 */
  dimColor?: boolean
  /** 为 false 时跳过 token 缓存（流式尾部的内容逐帧变化，缓存必然失效） */
  cacheTokens?: boolean
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
const TOKEN_CACHE_CAPACITY = 200
const TOKEN_CACHE_CHAR_BUDGET = 200_000
const TOKEN_CACHE_MAX_SOURCE_LENGTH = 20_000
const tokenCache = new Map<string, Token[]>()
let tokenCacheChars = 0

// 语法探针：命中任意 markdown 结构标记才值得走 lexer；内容过长时
// 只探测开头一段，纯文本直接跳过约 3ms 的 lexer 调用。
const MD_SYNTAX_MARKERS = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /
const SYNTAX_PROBE_WINDOW = 500

function looksLikePlainText(s: string): boolean {
  const probe =
    s.length > SYNTAX_PROBE_WINDOW ? s.slice(0, SYNTAX_PROBE_WINDOW) : s
  return !MD_SYNTAX_MARKERS.test(probe)
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

  if (
    tokenCache.size >= TOKEN_CACHE_CAPACITY ||
    tokenCacheChars + content.length > TOKEN_CACHE_CHAR_BUDGET
  ) {
    tokenCache.clear()
    tokenCacheChars = 0
  }
  tokenCache.set(content, tokens)
  tokenCacheChars += content.length
  return tokens
}

/**
 * 把 lexer 产出的 token 列表转成 React 节点序列：table 独立渲染，
 * 其余 token 的 ANSI 文本先累积拼接，再统一包成 Text（去除首尾空白）。
 */
function renderTokensToNodes(
  tokens: Token[],
  highlight: CliHighlight | null,
  dimColor: boolean,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let ansiText = ''

  const flushAnsiText = (): void => {
    if (!ansiText) return
    nodes.push(
      <Text key={nodes.length} dimColor={dimColor}>
        {ansiText.trim()}
      </Text>,
    )
    ansiText = ''
  }

  for (const token of tokens) {
    if (token.type === 'table') {
      flushAnsiText()
      nodes.push(
        <MarkdownTable
          key={nodes.length}
          token={token as Tokens.Table}
          highlight={highlight}
        />,
      )
    } else {
      ansiText += formatToken(token, 0, null, null, highlight)
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
function MarkdownImpl({ children, dimColor = false, cacheTokens = true }: Props): React.ReactNode {
  const [highlight, setHighlight] = React.useState<CliHighlight | null>(null)

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
    )
  }, [children, dimColor, highlight, cacheTokens])

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
    prev.cacheTokens === next.cacheTokens,
)
