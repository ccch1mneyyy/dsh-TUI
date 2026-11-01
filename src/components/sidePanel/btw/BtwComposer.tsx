/**
 * BtwComposer：btw 线程的追问输入框。草稿存在线程 store 里（面板与全屏
 * 共享），Enter 发送，Esc 退出编辑焦点但保留草稿，失败或忙时草稿原样保留。
 * 没有 steer/queue：sideQuery 是一次旁路问答，不进父会话。
 *
 * 键处理是纯函数 btwComposerKey，面板（usePanelInput 分发）与全屏场景
 * （useInput）共用；组件本身受控渲染（text 在 store，caret 是各处自己的）。
 */
import React from 'react'
import { Box, Text, InputCaret } from '../../../ui.js'
import { t } from '../../../i18n.js'
import { actionMatches } from '../../../utils/keymap.js'
import { flattenPasteInline } from '../../../channel/sanitize.js'
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
  /**
   * Ctrl+V / Alt+V：读剪贴板是异步的，纯函数只交出意图——surface 侧
   * （useBtwComposerPaste）读完再按实时草稿与 caret 落字。
   */
  readonly paste?: true
}

/** 运行时补充键位（ink Key 实际携带；SidePanelKeyFlags 类型面未列）。 */
type BtwKeyFlags = SidePanelKeyFlags & {
  readonly tab?: boolean
  readonly backspace?: boolean
  readonly delete?: boolean
  readonly home?: boolean
  readonly end?: boolean
  readonly return?: boolean
  /** 终端原生粘贴（bracketed paste）整块到达时置位。 */
  readonly isPasted?: boolean
}

/**
 * 单行 composer 的键语义。返回 null = 未消费（面板形态交宿主回退键，
 * 全屏形态交场景其余分支）；返回对象按 exitFocus > submit > 编辑 写回。
 * ←/→ 先移光标，贴到行首/行尾后返回未消费——面板形态据此切面板。
 * ↑ 让位给列表（选中轮，见 BtwPanelAdapter 的选中态）；↓ 在单行框里没有
 * 语义，吃掉即可，免得漏给主聊天去滚 transcript。
 */
export function btwComposerKey(state: BtwComposerState, input: string, key: BtwKeyFlags): BtwComposerKeyResult | null {
  if (key.escape === true) return { exitFocus: true }
  // The caret is per surface while the draft is shared through the store:
  // an edit on the other surface can leave this caret past the end.
  const caret = Math.min(state.caret, state.text.length)
  // 终端原生粘贴（Ctrl+Shift+V / 右键 / 终端自己接管的 Ctrl+V）整块到达并
  // 打上 isPasted：单行框先压成一行再插，纯换行的块是文本、绝不是 Enter。
  // 必须排在 plainReturn 之前——粘贴块也可能带着 return 标记。
  if (key.isPasted === true) {
    const text = flattenPasteInline(input)
    // 纯换行/空白压完是空格，trim 后为空 = 没有可插入的文本（不是 Enter）。
    if (text.trim() === '') return {}
    return { state: { text: state.text.slice(0, caret) + text + state.text.slice(caret), caret: caret + text.length } }
  }
  // Ctrl+V / Alt+V（keymap 的 paste 动作，可在 /settings 重映射）：读剪贴板
  // 是异步的，纯函数只交出意图，由 surface 侧按实时草稿与 caret 落字。
  if (actionMatches('paste', input, key)) return { paste: true }
  const plainReturn = (key.return_ === true || key.return === true || /^[\r\n]+$/u.test(input))
    && key.ctrl !== true && key.meta !== true && key.shift !== true
  if (plainReturn) return { submit: true }
  // Tab 离开编辑层去列表（与 TrajectoryPanel 同款双形态判定）。
  if (key.tab === true || input === '\t') return { exitFocus: true }
  // ↑ 也从编辑层上到列表：光标落在本轮标题上（列表形态默认选中最后一条）。
  if (key.upArrow === true) return { exitFocus: true }
  if (key.downArrow === true) return {}
  if (key.backspace === true || key.delete === true) {
    if (caret <= 0) return { state: { ...state, caret } }
    const at = previousCodePoint(state.text, caret)
    return { state: { text: state.text.slice(0, at) + state.text.slice(caret), caret: at } }
  }
  // Shift+←/→ 不归编辑层：返回未消费，面板形态下落宿主切面板（宿主的
  // leftArrow 判定不看 shift）——编辑中途也能一键换面板，不必先 Esc 收起。
  if ((key.leftArrow === true || key.rightArrow === true) && key.shift === true) return null
  // 光标先走、到头让位：还能移就移一格，已经贴着行首/行尾则返回未消费——
  // 面板形态下落宿主切面板，底栏「←/→ 切换」因此在编辑层同样成立；场景
  // 形态下无人接管，等于空操作。
  if (key.leftArrow === true) {
    const previous = previousCodePoint(state.text, caret)
    return previous === caret ? null : { state: { ...state, caret: previous } }
  }
  if (key.rightArrow === true) {
    const next = nextCodePoint(state.text, caret)
    return next === caret ? null : { state: { ...state, caret: next } }
  }
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
  onActivate,
}: {
  readonly state: BtwComposerState
  /** 编辑焦点（决定边框高亮与原生光标显示）。 */
  readonly focused: boolean
  /** 线程在途：Enter 不发送，提示稍候。 */
  readonly busy: boolean
  /** 提交失败/忙的本地提示（显示到下一次动作）。 */
  readonly notice?: { readonly text: string; readonly failure: boolean } | undefined
  /** 点击输入框进入编辑（默认箭头归导航，点进来才编辑）。 */
  readonly onActivate?: () => void
}): React.ReactNode {
  const { text, caret } = state
  const shown = Math.min(caret, text.length)
  const afterCaret = nextCodePoint(text, shown)
  return (
    <Box flexDirection="column" flexShrink={0}>
      {/* 一个真正的输入框：圆角边框 + 聚焦高亮；提示并到框内右缘，不另占行。
          点击 = 要在这里打字：事件继续冒泡，右栏的 onActivatePanel 才会把列焦点
          交给面板（stopImmediatePropagation 掐掉的正是祖先的 onClick——焦点还在
          聊天时点这里等于没点，得先点一次非输入区），然后再切本面板的编辑层。 */}
      <Box
        width="100%"
        flexShrink={0}
        borderStyle="round"
        borderColor={focused ? 'accent' : undefined}
        onClick={onActivate === undefined ? undefined : () => onActivate()}
      >
        <Box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
          <Text color={focused ? 'accent' : undefined} bold>{'›'}</Text>
          <Text>{' '}</Text>
          {focused ? (
            <>
              {/* 窄面板里让草稿先被截，键位提示保持完整（提示是可用性信息，
                  草稿尾部本来也看不见）。 */}
              <Box flexDirection="row" flexShrink={1} minWidth={0}>
                <Text wrap="truncate">{text.slice(0, shown)}</Text>
                {/* 光标锚在实际单元上，跟随截断后的文本而非原始长度。 */}
                <InputCaret>{text.slice(shown, afterCaret) || ' '}</InputCaret>
                {text.slice(afterCaret) !== '' ? <Text wrap="truncate">{text.slice(afterCaret)}</Text> : null}
              </Box>
              <Box flexGrow={1} flexShrink={0}><Text> </Text></Box>
              <Box flexShrink={0}><Text dimColor> {t('btw-input-hint-edit')}</Text></Box>
            </>
          ) : (
            // 未聚焦态只有一句占位：键位提示全在宿主底栏（按层换），框内不再重复
            // ——窄面板里也放不下第二段文字。
            <Text dimColor wrap="truncate">{text === '' ? t('btw-input-placeholder') : text}</Text>
          )}
        </Box>
      </Box>
      {notice !== undefined && (
        <Text color={notice.failure ? 'error' : undefined} wrap="truncate">{notice.text}</Text>
      )}
    </Box>
  )
}
