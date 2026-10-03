import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import Box from './design-system/ThemedBox.js'
import Text from './design-system/ThemedText.js'
import { useTheme } from './design-system/ThemeProvider.js'
import { cursorGlyphColor, getTheme } from '../theme.js'
import type { Color } from '../ink/styles.js'
import type { DOMElement } from '../ink/dom.js'
import measureElement from '../ink/measure-element.js'
import { useDeclaredCursor } from '../ink/hooks/use-declared-cursor.js'
import { useTerminalSize } from '../ink/hooks/use-terminal-size.js'
import { stringWidth } from '../ink/stringWidth.js'

/**
 * Window a single-line query around the caret so the visible slice fits
 * `avail` display cells (CJK display width, code-point safe — `[...s]`
 * iterates code points, not UTF-16 units). The caret character itself
 * always stays inside the window: leading characters are dropped until
 * before-caret text + caret fit, then after-caret text fills what remains.
 * `offset` arrives in UTF-16 units (callers move the caret by key count);
 * a mid-surrogate offset would split an emoji, so it snaps back to the
 * pair's start first.
 */
function windowQuery(
  query: string,
  offset: number,
  avail: number,
): { before: string; at: string; after: string; caretColumn: number } {
  const budget = Math.max(avail, 1)
  let caret = Math.max(0, Math.min(offset, query.length))
  if (
    caret > 0 &&
    caret < query.length &&
    query.charCodeAt(caret - 1) >= 0xd800 &&
    query.charCodeAt(caret - 1) <= 0xdbff &&
    query.charCodeAt(caret) >= 0xdc00 &&
    query.charCodeAt(caret) <= 0xdfff
  ) {
    caret-- // mid-surrogate: snap to the emoji's start
  }
  const beforeChars = [...query.slice(0, caret)]
  const at = caret < query.length ? [...query.slice(caret)][0]! : ' '
  const atWidth = Math.max(1, stringWidth(at))
  let caretColumn = 0
  for (const ch of beforeChars) caretColumn += stringWidth(ch)
  let start = 0
  while (start < beforeChars.length && caretColumn + atWidth > budget) {
    caretColumn -= stringWidth(beforeChars[start]!)
    start++
  }
  let rest = budget - caretColumn - atWidth
  let after = ''
  for (const ch of [...query.slice(caret + at.length)]) {
    const w = stringWidth(ch)
    if (w > rest) break
    after += ch
    rest -= w
  }
  return { before: beforeChars.slice(start).join(''), at, after, caretColumn }
}

/**
 * A single-line search input in a round-bordered box: `⌕ ` prefix, block
 * cursor at `cursorOffset` (theme cursor fill, or inverse cell when unset).
 * When empty and focused, the caret is a block **on the first
 * character of the placeholder** (opencode style, 2026-10 第七版) — it never
 * occupies a cell of its own, so text never shifts; the terminal-painted IME
 * preedit (pinyin) still lands at the declared native cursor next to it.
 *
 * The query row is strictly single-line: an overlong query is windowed
 * around the caret (horizontal scroll) instead of wrapping, so the native
 * cursor declaration below stays exact for any query length.
 */
export function SearchBox({
  query,
  placeholder = 'Search…',
  isFocused,
  isTerminalFocused,
  prefix = '⌕',
  width,
  cursorOffset,
  borderless = false,
  caretBlink = true,
  placeholderAlign = 'right',
}: {
  query: string
  placeholder?: string
  isFocused: boolean
  isTerminalFocused: boolean
  prefix?: string
  width?: number | string
  cursorOffset?: number
  borderless?: boolean
  /**
   * 空输入 + 焦点态那一行里占位文案的对齐（2026-10 落地页第四版新增）：
   * `right`（缺省，历史行为）贴框右缘；`left` 紧跟 `前缀 + 块状光标` 之后。
   * 共享组件——聊天页/选择器不传此 prop，渲染与从前逐字节一致。
   */
  placeholderAlign?: 'left' | 'right'
  /**
   * 光标闪烁相位（true = 光标样式、false = 常规）。落地页传入（约 550ms 一相位）；
   * 缺省 true 恒显示光标——其它使用方（选择器搜索等）保持不闪。
   *
   * 契约（第七版修订）：光标是**压在当前字符身上的块**（主题 cursor 填充，
   * 未声明时用 inverse；行尾时为空格），绝不另起一格、绝不吃掉字符；闪烁是
   * **纯样式切换**（光标 ↔ 常规），
   * 不增删任何字符——无头回归读的是视口纯文本，断言不会随相位抖动。
   */
  caretBlink?: boolean
}): React.ReactNode {
  const [themeName] = useTheme()
  const cursorTheme = getTheme(themeName)
  const cursorColor = cursorTheme.cursor ?? ''
  const cursorGlyph = cursorGlyphColor(cursorTheme)
  const caretCell = (text: string): React.ReactNode => !caretBlink
    ? <Text>{text}</Text>
    : cursorColor === ''
      ? <Text inverse>{text}</Text>
      : <Text backgroundColor={cursorColor as Color} color={cursorGlyph}>{text}</Text>
  const offset = cursorOffset ?? query.length
  const borderStyle = borderless ? undefined : 'round'
  const borderColor = isFocused ? 'suggestion' : undefined
  const borderDimColor = !isFocused
  // 空输入的行内光标（第七版重做）：光标压在**占位文本的第一个字符**身上
  // （只对那一个字符着光标样式，opencode 式）——绝不自己占一格、绝不把文字往右
  // 挤。不再拿终端焦点（DECSET 1004 focus 事件）当开关：只要这个输入框是
  // 本屏的焦点目标，光标就常在（用户原话「光标永远不消失 哪怕焦点没了」）。
  const inlineCaret = isFocused && query === ''

  // Content width of the box in display cells. Measured from yoga after
  // layout (resize re-layouts without any prop/state change, so measure on
  // every commit — the setState is a no-op when the width is unchanged);
  // the terminal-columns estimate only covers the very first frame.
  const { columns } = useTerminalSize()
  const chrome = borderless ? 0 : 4 // 2 border cells + paddingX 2
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null)
  const contentWidth = measuredWidth ?? Math.max(8, columns - chrome - 2)

  const prefixWidth = stringWidth(`${prefix} `)
  const win = windowQuery(query, offset, contentWidth - prefixWidth)

  // Park the native terminal cursor at the caret so IME preedit (pinyin)
  // renders inline at the input instead of the screen's bottom row (same
  // mechanism as PromptInput). The declaration hangs on the outer Box —
  // content stays a single Text (splitting it into flex siblings
  // reorders/drops glyphs on narrow widths), so the position is computed:
  // border (1) + paddingX (1) per edge when bordered, then the `prefix `
  // run and the windowed before-caret text, all in display cells.
  const showCaret = isFocused && isTerminalFocused
  // Clamp into the box's content area: on absurdly narrow layouts the
  // prefix alone can meet or exceed the content width, and the park must
  // never land outside the box's rect.
  const edge = borderless ? 0 : 2
  const maxColumn = edge + Math.max(0, contentWidth - 1)
  const caretColumn = Math.min(edge + prefixWidth + win.caretColumn, maxColumn)
  const declarationRef = useDeclaredCursor({
    line: borderless ? 0 : 1,
    column: caretColumn,
    active: showCaret,
  })
  const boxNodeRef = useRef<DOMElement | null>(null)
  const boxRef = useCallback(
    (node: DOMElement | null) => {
      boxNodeRef.current = node
      declarationRef(node)
    },
    [declarationRef],
  )
  useLayoutEffect(() => {
    const node = boxNodeRef.current
    if (!node) return
    // Layout runs before layout effects (reconciler resetAfterCommit), so a
    // zero raw width means a genuinely zero-width box — but a zero CONTENT
    // width (chrome eats the whole box) is a real, must-clamp case.
    const raw = measureElement(node).width
    if (raw > 0) {
      const w = Math.max(0, raw - chrome)
      setMeasuredWidth(prev => (prev === w ? prev : w))
    }
  })

  let content: React.ReactNode
  if (isFocused) {
    if (query) {
      // 第七版重做：光标常在（不再依赖终端焦点事件），压在当前字符身上
      // （对那一个字符着光标样式；行尾时为空格），闪烁相位只在
      // 光标 ↔ 常规之间切样式——字符常在、文字不位移。
      content = (
        <>
          <Text>{win.before}</Text>
          {caretCell(win.at)}
          {win.after !== '' && <Text>{win.after}</Text>}
        </>
      )
    }
  } else {
    content = query ? <Text>{query}</Text> : <Text>{placeholder}</Text>
  }

  return (
    <Box
      ref={boxRef}
      flexShrink={0}
      borderStyle={borderStyle}
      borderColor={borderColor}
      borderDimColor={borderDimColor}
      paddingX={borderless ? 0 : 1}
      width={width}
    >
      {inlineCaret ? (
        placeholderAlign === 'left' ? (
          <Box flexDirection="row" width="100%">
            <Text>{prefix} </Text>
            {/* 光标压在占位**第一个字符**身上（opencode 式）：对那一个字符
                着光标样式，整行不多占一格、文字位置不动；闪烁只切样式。 */}
            <Text dimColor wrap="truncate">
              {caretBlink ? caretCell(placeholder.slice(0, 1)) : placeholder.slice(0, 1)}
              {placeholder.slice(1)}
            </Text>
          </Box>
        ) : (
          <Box flexDirection="row" width="100%">
            <Text>{prefix} </Text>
            {/* 右对齐变体（非落地页使用方）：占位钉在右缘，行首没有可压的
                字符——光标画在光标位那一格（空格），同样不挤任何文字。 */}
            {caretCell(' ')}
            <Box flexGrow={1} />
            <Text dimColor wrap="truncate">
              {placeholder}
            </Text>
          </Box>
        )
      ) : (
        <Text dimColor={!isFocused} wrap="truncate-end">
          {prefix} {content}
        </Text>
      )}
    </Box>
  )
}
