import React, { type ReactNode } from 'react'
import Link from './components/Link.js'
import Text from './components/Text.js'
import type { Color } from './styles.js'
import { Parser, type Color as TerminalColor, type TextStyle } from './termio.js'

type Props = { children: string; dimColor?: boolean }

function rendererColor(color: TerminalColor): Color | undefined {
  if (color.type === 'default') return undefined
  if (color.type === 'rgb') return `rgb(${color.r},${color.g},${color.b})`
  if (color.type === 'indexed') return `ansi256(${color.index})`
  const name = color.name.startsWith('bright')
    ? `${color.name.slice(6).toLowerCase()}Bright`
    : color.name
  return `ansi:${name}` as Color
}

function styledRun(text: string, style: TextStyle, forceDim: boolean): ReactNode {
  const weight = forceDim || style.dim ? { dim: true as const }
    : style.bold ? { bold: true as const } : {}
  return <Text {...weight} color={rendererColor(style.fg)} backgroundColor={rendererColor(style.bg)}
    italic={style.italic} underline={style.underline !== 'none'}
    strikethrough={style.strikethrough} inverse={style.inverse}>{text}</Text>
}

/** Project parser actions onto text leaves; control-only input has no layout. */
export const Ansi = React.memo(function Ansi({ children, dimColor = false }: Props) {
  if (typeof children !== 'string') return <Text dim={dimColor}>{String(children)}</Text>
  if (!children) return null
  if (!children.includes('\x1b')) return <Text dim={dimColor}>{children}</Text>

  const content: ReactNode[] = []
  let url: string | undefined
  for (const action of new Parser().feed(children)) {
    if (action.type === 'link') {
      url = action.action.type === 'start' ? action.action.url : undefined
    } else if (action.type === 'text' && action.graphemes.length) {
      const text = action.graphemes.map(part => part.value).join('')
      const node = styledRun(text, action.style, dimColor)
      content.push(url ? <Link key={content.length} url={url}>{node}</Link>
        : <React.Fragment key={content.length}>{node}</React.Fragment>)
    }
  }
  return content.length ? <Text dim={dimColor}>{content}</Text> : null
})
