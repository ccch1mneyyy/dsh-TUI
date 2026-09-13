import React from 'react'
import { t } from '../i18n.js'
import { Box, Text } from '../ui.js'
import type { ChatRow } from '../dsh-adapter/channel.js'
import type { TuiRewindMode } from '../dsh-adapter/extension-events.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { HintLine } from './design-system/HintLine.js'
import { listWindow } from './listWindow.js'
import { useOverlayListRows } from './OverlayAbove.js'

/**
 * Double-Esc rewind picker (double-tap Esc rewinds the selected message and/or
 * conversation to a previous point in time: lists the user's past messages
 * newest-first; selecting one and confirming rewinds the conversation to
 * that point (the message comes back into the input for re-editing).
 *
 * The confirm pane has two shapes: the plain one (Enter rewinds), and —
 * when a plugin answered the tui/rewind-prompt decision with extra modes —
 * a choice list whose option zero is always the built-in conversation-only
 * rewind, followed by the plugin's modes (e.g. "also restore files").
 */
export function RewindPicker({
  rows,
  focusIndex,
  confirmRow,
  modes = null,
  modeIndex = 0,
  busy = false,
  onPickRow,
  onConfirm,
  onPickMode,
}: {
  rows: readonly ChatRow[]
  focusIndex: number
  confirmRow: ChatRow | null
  /** Plugin-offered rewind modes (tui/rewind-prompt); null = plain confirm. */
  modes?: readonly TuiRewindMode[] | null
  /** Focused option in the modes list (0 = conversation-only). */
  modeIndex?: number
  /** True while the plugin decision is in flight. */
  busy?: boolean
  /**
   * Mouse pick on a list row (fullscreen): sets focus only — rewind is a
   * high-risk invisible-confirm operation, so stepping into the confirm
   * state stays an explicit keyboard Enter.
   */
  onPickRow?: (index: number) => void
  /** Mouse click on the plain confirm row: executes the rewind directly —
   *  the confirm pane itself is the explicit confirmation layer. */
  onConfirm?: () => void
  /** Mouse pick on a modes-list option: executes that mode directly. */
  onPickMode?: (index: number) => void
}): React.ReactNode {
  // 两个列表的行预算都来自最近一层 OverlayAbove 的有效高度（已钳到输入簇
  // 上方的真实空间，#493/#698）。hook 不进条件分支：无论当前画的是模式列
  // 表、纯确认页还是消息列表，调用顺序都一致。框架行按实际渲染数：
  // 模式列表：挂载包裹 marginTop 1 + Pane 2 + 标题/预览同一行 1 + marginBottom 1
  //   + 页脚 1 = 6（rowCosts 只算选项行，首项是带描述的"仅对话"选项）；
  // 消息列表：挂载包裹 marginTop 1 + Pane 2 + 标题+副标题 2 + marginBottom 1
  //   + 页脚 1 = 7，插件决策在途时再多一行「等待插件」状态行（busy）。
  const modeListRows = useOverlayListRows(6)
  const listRows = useOverlayListRows(confirmRow === null && busy ? 8 : 7)
  if (confirmRow !== null) {
    if (modes !== null) {
      // Plugin modes: a described choice list (one extra row per
      // description), windowed like the message list below.
      const rowCosts = [2, ...modes.map(mode => (mode.description === undefined ? 1 : 2))]
      const { start, end } = listWindow(rowCosts, modeIndex, modeListRows)
      const options: readonly { key: string; label: string; description?: string }[] = [
        { key: 'conversation', label: t('rewind-mode-default'), description: t('rewind-confirm-desc') },
        ...modes.map(mode => ({
          key: mode.id,
          label: mode.label,
          ...(mode.description === undefined ? {} : { description: mode.description }),
        })),
      ]
      return (
        <Pane color="permission">
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text color="remember" bold>
                {t('rewind-confirm-title')}
              </Text>
              <Text dimColor>{preview(confirmRow.text)}</Text>
            </Box>
            {options.slice(start, end).map((option, index) => {
              const absoluteIndex = start + index
              return (
                <ListItem
                  key={option.key}
                  isFocused={absoluteIndex === modeIndex}
                  description={option.description}
                  showScrollUp={absoluteIndex === start && start > 0}
                  showScrollDown={absoluteIndex === end - 1 && end < options.length}
                  onClick={onPickMode === undefined ? undefined : () => onPickMode(absoluteIndex)}
                >
                  {option.label}
                </ListItem>
              )
            })}
          </Box>
          <Text dimColor italic>
            <HintLine text={t('hint-select-exit')} />
          </Text>
        </Pane>
      )
    }
    return (
      <Pane color="permission">
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color="remember" bold>
              {t('rewind-confirm-title')}
            </Text>
          </Box>
          <ListItem isFocused={false} description={t('rewind-confirm-desc')} onClick={onConfirm}>
            {preview(confirmRow.text)}
          </ListItem>
          <Text dimColor italic>
            <HintLine text={t('hint-rewind-back')} />
          </Text>
        </Box>
      </Pane>
    )
  }

  // 焦点窗口化按行预算：首项带 'last message' 描述占 2 行、其余 1 行
  //（ListItem 保证单行截断）。rewind 是不可见确认的高危操作，焦点必须
  // 始终在屏。
  const { start, end } = listWindow(
    rows.map((_, i) => (i === 0 ? 2 : 1)),
    focusIndex,
    listRows,
  )
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text color="remember" bold>
            {t('rewind-title')}
          </Text>
          <Text dimColor>{t('rewind-subtitle')}</Text>
        </Box>
        {rows.length === 0 ? (
          <ListItem isFocused={false}>{t('rewind-empty')}</ListItem>
        ) : (
          rows.slice(start, end).map((row, index) => {
            const absoluteIndex = start + index
            return (
              <ListItem
                key={row.id}
                isFocused={absoluteIndex === focusIndex}
                description={absoluteIndex === 0 ? t('rewind-last-message') : undefined}
                showScrollUp={absoluteIndex === start && start > 0}
                showScrollDown={absoluteIndex === end - 1 && end < rows.length}
                onClick={
                  onPickRow !== undefined && !busy
                    ? () => onPickRow(absoluteIndex)
                    : undefined
                }
              >
                {preview(row.text)}
              </ListItem>
            )
          })
        )}
        {busy && <Text dimColor>{t('rewind-waiting-plugins')}</Text>}
      </Box>
      <Text dimColor italic>
        <HintLine text={t('hint-select-exit')} />
      </Text>
    </Pane>
  )
}

/** One-line preview of a message (newlines flattened, capped). */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`
}
