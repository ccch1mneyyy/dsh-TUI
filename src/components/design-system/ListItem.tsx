import React, { type ReactNode } from 'react'
import { Box, Text } from '../../ui.js'
import { useDeclaredCursor } from '../../ink/hooks/use-declared-cursor.js'
import { POINTER, DOWN_ARROW, UP_ARROW, TICK } from '../../cc/figures.js'

export type ListItemProps = {
  /** Whether this item is currently focused (keyboard selection).
   *  Shows the pointer indicator (❯) when true. */
  isFocused: boolean
  /** Whether this item is selected (chosen/checked).
   *  Shows the checkmark indicator (✓) when true. */
  isSelected?: boolean
  /** The content to display for this item. */
  children: ReactNode
  /** Optional description text displayed below the main content. */
  description?: string
  /** Show a down arrow indicator instead of pointer (scroll hints). */
  showScrollDown?: boolean
  /** Show an up arrow indicator instead of pointer (scroll hints). */
  showScrollUp?: boolean
  /** Whether to apply automatic styling based on focus/selection state. */
  styled?: boolean
  /** Disabled items show dimmed text and no indicators. */
  disabled?: boolean
  /**
   * Whether this ListItem should declare the terminal cursor position.
   * Set false when a child (e.g. BaseTextInput) declares its own cursor.
   * @default true
   */
  declareCursor?: boolean
}

/**
 * A list item for selection UIs (ported from the leak's
 * design-system/ListItem.tsx): `❯` pointer for the focused row, `✓`
 * checkmark for the selected row, description on an indented second line,
 * and CC's color states (focused = suggestion blue, selected = success
 * green).
 */
export function ListItem({
  isFocused,
  isSelected = false,
  children,
  description,
  showScrollDown,
  showScrollUp,
  styled = true,
  disabled = false,
  declareCursor,
}: ListItemProps): React.ReactNode {
  // Park the native terminal cursor on the pointer indicator so screen
  // readers / magnifiers track the focused item (CC behavior). (0,0) is the
  // top-left of this Box, where the pointer renders.
  const cursorRef = useDeclaredCursor({
    line: 0,
    column: 0,
    active: isFocused && !disabled && declareCursor !== false,
  })

  function renderIndicator(): ReactNode {
    if (disabled) {
      return <Text> </Text>
    }
    if (isFocused) {
      return <Text color="suggestion">{POINTER}</Text>
    }
    if (showScrollDown) {
      return <Text dimColor>{DOWN_ARROW}</Text>
    }
    if (showScrollUp) {
      return <Text dimColor>{UP_ARROW}</Text>
    }
    return <Text> </Text>
  }

  function getTextColor(): 'success' | 'suggestion' | 'inactive' | undefined {
    if (disabled) return 'inactive'
    if (!styled) return undefined
    if (isSelected) return 'success'
    if (isFocused) return 'suggestion'
    return undefined
  }

  // 窗口化列表（ModelPicker/History/Rewind/Select）按固定行高切片：字符串
  // 内容必须恒占一行——压平内嵌换行（历史命令可能带 \n），超宽 truncate
  // 而非换行，否则一项实际占多行会把焦点行裁出浮层（二次审查实证）。
  // 压平必须递归穿透 Fragment/数组：ThemePicker 的 label 就是包着用户
  // displayName 的 Fragment，而 customTheme 允许 displayName 保留内部
  // 换行（三轮审查实证：不递归则 Fragment 里的 'Foo\nBar' 仍渲染两行）。
  // 非 Fragment 的 element（如调用方自己的 <Text>）保留原样——其子树高度
  // 由调用方负责。
  const flatChildren = flattenDeep(children)

  return (
    <Box ref={cursorRef} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        {renderIndicator()}
        {styled ? (
          <Text color={getTextColor()} dimColor={disabled} wrap="truncate">
            {flatChildren}
          </Text>
        ) : (
          flatChildren
        )}
        {isSelected && !disabled && <Text color="success">{TICK}</Text>}
      </Box>
      {description && (
        <Box paddingLeft={2}>
          <Text color="inactive" wrap="truncate">
            {flattenLine(description)}
          </Text>
        </Box>
      )}
    </Box>
  )
}

/** 单行化：内嵌换行折叠为空格（行尾/行首换行随之消除）。 */
function flattenLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ')
}

/**
 * 递归单行化：字符串直接压平；数组逐元素递归；Fragment 是透明结构包装，
 * 递归进其 children（保留 key/props）。其他 element 原样保留。
 * 数组必须走 React.Children.map 而非原生 map：后者把静态 JSX children
 * 变成无 key 的动态数组，/theme（label 含 Fragment）会稳定触发 React
 * key warning（四次审查实证）。
 */
function flattenDeep(node: ReactNode): ReactNode {
  if (typeof node === 'string') return flattenLine(node)
  if (Array.isArray(node)) return React.Children.map(node, flattenDeep)
  if (React.isValidElement(node) && node.type === React.Fragment) {
    const frag = node as React.ReactElement<{ children?: ReactNode }>
    return React.cloneElement(frag, undefined, flattenDeep(frag.props.children))
  }
  return node
}
