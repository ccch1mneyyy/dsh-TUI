import React from 'react'
import { Box, Text, useTerminalSize } from '../ui.js'
import { usePageInset } from './PageMargin.js'
import type { Color } from '../ink/styles.js'
import type { Theme } from '../theme.js'

/**
 * 全屏草稿编辑的挂载层。编辑状态（value/caret/选区/折叠）全部住在
 * PromptInput 内部，展开视图却必须盖住整棵 Chat 树的每个后绘兄弟
 * （StatusLine、OverlayAbove、TooltipLayer）——渲染器按树序绘制，
 * absolute 浮层只有作为根 Box 的最后一个孩子才天然压过一切
 * （TooltipLayer 的同款契约）。PromptInput 因此把展开视图的 React
 * 节点发布到这个 module 级 store，`PromptEditorLayer`（挂在 Chat 根
 * Box 末尾）订阅并渲染；节点是 PromptInput 每次渲染的新鲜闭包，
 * 命中/拖拽/按钮 handler 无需任何额外的状态同步管道。
 *
 * 节点写入用 useInsertionEffect：sink 的同步重渲染发生在 layout
 * 阶段之前，PromptInput 的 useDeclaredCursor（layout effect）读到
 * 的 ref 已经指向编辑区的 Box，首帧光标声明即正确。
 */

type EditorNode = React.ReactNode | null

let editorNode: EditorNode = null
const listeners = new Set<() => void>()

/** Publish (or withdraw, with null) the fullscreen editor subtree. */
export function setPromptEditorNode(node: EditorNode): void {
  if (node === editorNode) return
  editorNode = node
  for (const listener of listeners) listener()
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

function snapshot(): EditorNode {
  return editorNode
}

/**
 * The fullscreen sink, mounted once at the very end of Chat's root Box.
 * The absolute cover is `opaque` so its padding/blank cells never bleed
 * the covered transcript through, and it swallows stray clicks so the
 * conversation underneath cannot react to a click meant for the editor.
 */
export function PromptEditorLayer(): React.ReactNode {
  const node = React.useSyncExternalStore(subscribe, snapshot)
  if (node === null) return null
  // Full-bleed cover: under PageMargin the Chat root box starts at the
  // content origin, so the editor must extend into the page margins up to
  // the terminal edges — the editor is a whole-screen surface, and the
  // margin strips must be covered rather than letting the transcript
  // bleed through.
  const inset = usePageInset()
  const size = useTerminalSize()
  return (
    <Box
      position="absolute"
      top={-inset.y}
      left={-inset.x}
      width={size.columns + 2 * inset.x}
      height={size.rows + 2 * inset.y}
      flexDirection="column"
      flexShrink={0}
      overflow="hidden"
      opaque
      onClick={(event) => {
        event.stopImmediatePropagation()
      }}
    >
      {node}
    </Box>
  )
}

/**
 * A mouse-friendly pill button for the editor chrome (send / collapse /
 * the ⤢ close affordance). Hover swaps the surface so the affordance
 * reads at a glance — the same interaction language as the transcript's
 * clickable rows and the session browser's menu items.
 */
export function EditorButton({
  label,
  hint,
  onClick,
  primary,
  accent,
}: {
  /** Button text, e.g. `⏎ 发送`. */
  label: string
  /** Dim trailing hint inside the pill, e.g. `Ctrl+Enter`. */
  hint?: string
  onClick: () => void
  /** Filled variant (the primary action); default is the outline look. */
  primary?: boolean
  /** Accent theme token / raw color for the filled variant. */
  accent?: keyof Theme | Color
}): React.ReactNode {
  const [hovered, setHovered] = React.useState(false)
  const text = hint === undefined ? ` ${label} ` : ` ${label} ${hint} `
  return (
    <Box
      flexShrink={0}
      backgroundColor={
        primary
          ? hovered
            ? 'userMessageBackgroundHover'
            : (accent ?? 'claude')
          : hovered
            ? 'userMessageBackgroundHover'
            : undefined
      }
      onClick={(event) => {
        event.stopImmediatePropagation()
        onClick()
      }}
      onMouseEnter={() => {
        setHovered(true)
      }}
      onMouseLeave={() => {
        setHovered(false)
      }}
    >
      <Text
        bold={primary || hovered}
        color={primary && !hovered ? 'inverseText' : undefined}
        dimColor={!primary && !hovered}
      >
        {text}
      </Text>
    </Box>
  )
}
