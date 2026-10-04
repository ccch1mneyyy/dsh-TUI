/**
 * BtwComposer：btw 线程的追问输入框（设计 btw-panel.md §交互规格）。
 *
 * 照 AgentMessageComposer 的**交互模式**实现（team-ui 参考，类型不兼容
 * 不直接 import——设计 §当前接缝已注明）：独立草稿（存线程 store，跨
 * 面板/全屏共享）、Enter 发送、Esc 退出编辑焦点但保留草稿、失败/忙时
 * 草稿原样保留。无 steer/queue 选项——sideQuery 是旁路单轮，不是父
 * 会话投递。
 *
 * 键处理是**纯函数** btwComposerKey：面板形态（usePanelInput 分发）与
 * 全屏场景（useInput）两条路径共用同一份语义；组件本身受控渲染
 * （text 在 store，caret 是各 surface 的本地态）。
 */
import React from 'react'
import { Box, Text } from '../../../ui.js'
import { t } from '../../../i18n.js'
import type { SidePanelKeyFlags } from '../types.js'
import { nextCodePoint, previousCodePoint } from '../../AgentMessageComposer.js'

/** 编辑态（text 来自线程 store；caret 属于当前 surface）。 */
export interface BtwComposerState {
  readonly text: string
  readonly caret: number
}

/** btwComposerKey 的裁决：undefined 字段 = 无此动作；null 整体 = 键未消费。 */
export interface BtwComposerKeyResult {
  readonly state?: BtwComposerState
  readonly submit?: boolean
  /** Esc/Tab：退出编辑焦点（草稿保留），焦点回落线程列表/宿主。 */
  readonly exitFocus?: boolean
}

/** 运行时补充键位（ink Key 实际携带；SidePanelKeyFlags 类型面未列）。 */
type BtwKeyFlags = SidePanelKeyFlags & {
  readonly tab?: boolean
  readonly backspace?: boolean
  readonly delete?: boolean
  readonly home?: boolean
  readonly end?: boolean
  readonly return?: boolean
}

/**
 * 单行 composer 的键语义。返回 null = 未消费（面板形态交宿主回退键，
 * 全屏形态交场景其余分支）；返回对象按 exitFocus > submit > 编辑 写回。
 */
export function btwComposerKey(state: BtwComposerState, input: string, key: BtwKeyFlags): BtwComposerKeyResult | null {
  if (key.escape === true) return { exitFocus: true }
  // The caret is per surface while the draft is shared through the store:
  // an edit on the other surface can leave this caret past the end.
  const caret = Math.min(state.caret, state.text.length)
  const plainReturn = (key.return_ === true || key.return === true || /^[\r\n]+$/u.test(input))
    && key.ctrl !== true && key.meta !== true && key.shift !== true
  if (plainReturn) return { submit: true }
  // Tab 离开编辑层去列表（与 TrajectoryPanel 同款双形态判定）。
  if (key.tab === true || input === '\t') return { exitFocus: true }
  if (key.backspace === true || key.delete === true) {
    if (caret <= 0) return { state: { ...state, caret } }
    const at = previousCodePoint(state.text, caret)
    return { state: { text: state.text.slice(0, at) + state.text.slice(caret), caret: at } }
  }
  if (key.leftArrow === true) return { state: { ...state, caret: previousCodePoint(state.text, caret) } }
  if (key.rightArrow === true) return { state: { ...state, caret: nextCodePoint(state.text, caret) } }
  if (key.home === true) return { state: { ...state, caret: 0 } }
  if (key.end === true) return { state: { ...state, caret: state.text.length } }
  if (input !== '' && key.ctrl !== true && key.meta !== true) {
    return { state: { text: state.text.slice(0, caret) + input + state.text.slice(caret), caret: caret + input.length } }
  }
  return null
}

export function BtwComposer({
  state,
  focused,
  busy,
  notice,
}: {
  readonly state: BtwComposerState
  /** 编辑焦点（决定 caret 反白块的画法）。 */
  readonly focused: boolean
  /** 线程在途：Enter 不发送，提示稍候。 */
  readonly busy: boolean
  /** 提交失败/忙的本地提示（显示到下一次动作）。 */
  readonly notice?: { readonly text: string; readonly failure: boolean } | undefined
}): React.ReactNode {
  const { text, caret } = state
  const shown = Math.min(caret, text.length)
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box flexDirection="row" flexShrink={0}>
        <Text color="warning" bold>{'› '}</Text>
        {focused ? (
          <>
            <Text>{text.slice(0, shown)}</Text>
            <Text inverse>{text.slice(shown, shown + 1) || ' '}</Text>
            {text.slice(shown + 1) !== '' ? <Text>{text.slice(shown + 1)}</Text> : null}
          </>
        ) : (
          <Text dimColor>{text === '' ? t('btw-thread-followup') : text}</Text>
        )}
      </Box>
      {notice !== undefined && (
        <Text color={notice.failure ? 'error' : undefined} wrap="truncate">{notice.text}</Text>
      )}
    </Box>
  )
}
