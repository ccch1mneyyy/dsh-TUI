/**
 * BtwComposer：btw 线程的追问输入框。草稿存在线程 store 里（面板与全屏
 * 共享），Enter 发送，Esc 退出编辑焦点但保留草稿，失败或忙时草稿原样保留。
 * 没有 steer/queue：sideQuery 是一次旁路问答，不进父会话。
 *
 * 键处理是纯函数 btwComposerKey，面板（usePanelInput 分发）与全屏场景
 * （useInput）共用；组件本身受控渲染（text 在 store，caret 是各处自己的）。
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

/** btwComposerKey 的结果：undefined 字段 = 无此动作；整体为 null = 键未消费。 */
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
