import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import Box from './design-system/ThemedBox.js'
import Text from './design-system/ThemedText.js'
import { useTheme } from './design-system/ThemeProvider.js'
import { cursorGlyphColor, getTheme } from '../theme.js'
import type { Color } from '../ink/styles.js'
import type { DOMElement } from '../ink/dom.js'
import measureElement from '../ink/measure-element.js'
import { useDeclaredCursor, useNativeCursor } from '../ink/hooks/use-declared-cursor.js'
import { useTerminalSize } from '../ink/hooks/use-terminal-size.js'
import { stringWidth } from '../ink/stringWidth.js'
import { snapOffImageToken, type ImageTokenSpan } from './composerImageTokens.js'

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
  imageSpans: readonly ImageTokenSpan[],
): { before: string; at: string; after: string; caretColumn: number; start: number; caret: number } {
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
  caret = snapOffImageToken(imageSpans, caret, 'nearest')
  const beforeChars = [...query.slice(0, caret)]
  const tokenAtCaret = imageSpans.find(span => span.start === caret)
  const at = tokenAtCaret !== undefined ? tokenAtCaret.token : caret < query.length ? [...query.slice(caret)][0]! : ' '
  const atWidth = Math.max(1, stringWidth(at))
  let caretColumn = 0
  for (const ch of beforeChars) caretColumn += stringWidth(ch)
  let start = 0
  while (start < beforeChars.length && caretColumn + atWidth > budget) {
    caretColumn -= stringWidth(beforeChars[start]!)
    start++
  }
  const before = beforeChars.slice(start).join('')
  const rawStart = caret - before.length
  const windowStart = snapOffImageToken(imageSpans, rawStart, 'end')
  caretColumn -= stringWidth(query.slice(rawStart, windowStart))
  let rest = budget - caretColumn - atWidth
  let after = ''
  for (const ch of [...query.slice(caret + at.length)]) {
    const w = stringWidth(ch)
    if (w > rest) break
    after += ch
    rest -= w
  }
  const end = snapOffImageToken(imageSpans, caret + at.length + after.length, 'start')
  return { before: query.slice(windowStart, caret), at, after: query.slice(caret + at.length, end), caretColumn, start: windowStart, caret }
}

/**
 * A single-line search input in a round-bordered box: `⌕ ` prefix and a native
 * cursor at `cursorOffset`. Static snapshots retain the theme-painted caret.
 * When empty with a left-aligned placeholder, the caret sits on its first
 * character; text stays in place and IME preedit uses the same native anchor.
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
  imageSpans = [],
}: {
  query: string
  placeholder?: string
  isFocused: boolean
  isTerminalFocused: boolean
  prefix?: string
  width?: number | string
  cursorOffset?: number
  borderless?: boolean
  /** Capability-backed image chips, sharing the chat composer's atomic geometry. */
  imageSpans?: readonly ImageTokenSpan[]
  /**
   * 空输入 + 焦点态那一行里占位文案的对齐（2026-10 落地页第四版新增）：
   * `right`（缺省，历史行为）贴框右缘；`left` 紧跟前缀。
   * 共享组件——聊天页/选择器不传此 prop，渲染与从前逐字节一致。
   */
  placeholderAlign?: 'left' | 'right'
  /**
   * 无原生光标的呈现环境使用的闪烁相位（仅切换样式，不增删字符）。
   * TTY 光标的闪烁与动画由终端配置控制。
   */
  caretBlink?: boolean
}): React.ReactNode {
  const [themeName] = useTheme()
  const nativeCursor = useNativeCursor()
  const cursorTheme = getTheme(themeName)
  const cursorColor = cursorTheme.cursor ?? ''
  const cursorGlyph = cursorGlyphColor(cursorTheme)
  const caretCell = (text: string, image = false): React.ReactNode => !image && (nativeCursor || !caretBlink)
    ? <Text>{text}</Text>
    : cursorColor === ''
      ? <Text inverse>{text}</Text>
      : <Text backgroundColor={cursorColor as Color} color={cursorGlyph}>{text}</Text>
  const offset = cursorOffset ?? query.length
  const borderStyle = borderless ? undefined : 'round'
  const borderColor = isFocused ? 'suggestion' : undefined
  const borderDimColor = !isFocused
  // Empty left-aligned inputs park on the placeholder's first character;
  // the terminal owns the cursor's appearance when its window loses focus.
  const inlineCaret = isFocused && query === ''

  // Content width of the box in display cells. Measured from yoga after
  // layout (resize re-layouts without any prop/state change, so measure on
  // every commit — the setState is a no-op when the width is unchanged);
  // the terminal-columns estimate only covers the very first frame.
  const { columns } = useTerminalSize()
  const chrome = borderless ? 0 : 4 // 2 border cells + paddingX 2
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null)
  const contentWidth = measuredWidth ?? Math.max(8, columns - chrome - 2)

  const prefixText = prefix === '' ? '' : `${prefix} `
  const prefixWidth = stringWidth(prefixText)
  const win = windowQuery(query, offset, contentWidth - prefixWidth, imageSpans)
  const renderQueryPart = (text: string, start: number): React.ReactNode => {
    if (imageSpans.length === 0) return <Text>{text}</Text>
    const pieces: React.ReactNode[] = []
    let pos = start
    for (const span of imageSpans) {
      if (span.start < start || span.end > start + text.length) continue
      if (pos < span.start) pieces.push(<Text key={`text-${pos}`}>{query.slice(pos, span.start)}</Text>)
      pieces.push(<Text key={`image-${span.start}`} color="suggestion">{span.token}</Text>)
      pos = span.end
    }
    if (pos < start + text.length) pieces.push(<Text key={`text-${pos}`}>{query.slice(pos, start + text.length)}</Text>)
    return pieces.length === 0 ? <Text>{text}</Text> : <>{pieces}</>
  }

  // Park the native terminal cursor at the caret so IME preedit (pinyin)
  // renders inline at the input instead of the screen's bottom row (same
  // mechanism as PromptInput). The declaration hangs on the outer Box —
  // content stays a single Text (splitting it into flex siblings
  // reorders/drops glyphs on narrow widths), so the position is computed:
  // border (1) + paddingX (1) per edge when bordered, then the `prefix `
  // run and the windowed before-caret text, all in display cells.
  const showCaret = isFocused && (nativeCursor || isTerminalFocused)
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
    visible: nativeCursor,
  })
  const boxNodeRef = useRef<DOMElement | null>(null)
  const boxRef = useCallback(
    (node: DOMElement | null) => {
      boxNodeRef.current = node
      const cleanup = declarationRef(node)
      if (node === null) return
      return () => {
        if (typeof cleanup === 'function') cleanup()
        if (boxNodeRef.current === node) boxNodeRef.current = null
      }
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
      // Keep the visible text intact; only the painted fallback changes
      // the caret glyph's style as its blink phase advances.
      content = (
        <>
          {renderQueryPart(win.before, win.start)}
          {caretCell(win.at, imageSpans.some(span => span.start === win.caret))}
          {win.after !== '' && renderQueryPart(win.after, win.caret + win.at.length)}
        </>
      )
    }
  } else {
    content = query ? renderQueryPart(query, 0) : <Text>{placeholder}</Text>
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
            <Text>{prefixText}</Text>
            {/* An empty placeholder still reserves a blank caret cell
                so the input row cannot collapse. */}
            <Text dimColor wrap="truncate">
              {caretCell(placeholder.slice(0, 1) || ' ')}
              {placeholder.slice(1)}
            </Text>
          </Box>
        ) : (
          <Box flexDirection="row" width="100%">
            <Text>{prefixText}</Text>
            {/* A right-aligned placeholder leaves a blank caret cell at
                the input origin. */}
            {caretCell(' ')}
            <Box flexGrow={1} />
            <Text dimColor wrap="truncate">
              {placeholder}
            </Text>
          </Box>
        )
      ) : (
        <Text dimColor={!isFocused} wrap="truncate-end">
          {prefixText}{content}
        </Text>
      )}
    </Box>
  )
}
