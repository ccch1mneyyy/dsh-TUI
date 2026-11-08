/**
 * btw composer 的剪贴板粘贴：面板（BtwPanelAdapter）与全屏场景
 * （BtwThreadScene）共用一份实现。
 *
 * 键语义在 BtwComposer 的纯函数里（`{ paste: true }`），这里只负责异步
 * 读取与落点，契约与主输入框 / 问卷面板一致：
 *
 * - 读取期间用户继续打字是安全的：落点用**实时**草稿与当前 caret，
 *   不拿按键那一刻的快照覆盖草稿；
 * - 一次读取在途时重复按键被忽略（防重入），组件卸载后不写 store；
 * - btw 是纯文本单行输入：图片/文件剪贴板明确提示，绝不静默落到别处。
 *
 * 测试缝：面板由 registry 构造，传不进 prop，所以这里保留一个模块级
 * reader 覆盖（仓内已有 `__setHandoffAckStateForTest` 等同类先例）；
 * 全屏场景另可经 prop 注入。
 */
import React from 'react'
import { t } from '../../../i18n.js'
import { flattenPasteInline } from '../../../channel/sanitize.js'
import { readClipboard, type ClipboardRead } from '../../../utils/clipboard.js'
import { btwThreads } from './threads.js'

/** 粘贴失败的本地提示（显示到下一次动作，与提交失败同一条通道）。 */
export interface BtwPasteNotice {
  readonly text: string
  readonly failure: boolean
}

let clipboardReader: () => Promise<ClipboardRead> = readClipboard

/** 无头回归注入假 reader；传 undefined 还原真实读取。 */
export function setBtwClipboardReaderForTest(next?: () => Promise<ClipboardRead>): void {
  clipboardReader = next ?? readClipboard
}

/**
 * 把一段文本按码点光标插入草稿。导出给回归脚本做纯函数断言。
 * @param draft - 当前草稿。
 * @param caret - 光标（会被夹到草稿长度内）。
 * @param text - 已 flatten 的单行文本。
 */
export function insertBtwPaste(draft: string, caret: number, text: string): { text: string; caret: number } {
  const at = Math.min(Math.max(0, caret), draft.length)
  return { text: draft.slice(0, at) + text + draft.slice(at), caret: at + text.length }
}

export function useBtwComposerPaste(opts: {
  readonly sessionId: string
  /** 当前 surface 的光标（ref：异步返回时读实时值）。 */
  readonly caretRef: { readonly current: number }
  readonly setCaret: (caret: number) => void
  readonly setNotice: (notice: BtwPasteNotice | null) => void
  /** 全屏场景的注入缝；不传走模块级 reader（测试可覆盖）。 */
  readonly readClipboardOverride?: (() => Promise<ClipboardRead>) | undefined
}): () => void {
  const { sessionId, caretRef, setCaret, setNotice, readClipboardOverride } = opts
  // 读取在途：重复 Ctrl+V 不排队（一次粘贴只落一次字）。
  const busyRef = React.useRef(false)
  // 读取在途时会话可能切换（面板跨会话常驻）：落点必须仍是按键时的会话，
  // 否则文本写进旧草稿、光标却设到新 surface 上。沿用主输入框的租约语义：
  // 上下文变了就丢弃这次读取，绝不覆盖更新的草稿。
  const sessionRef = React.useRef(sessionId)
  sessionRef.current = sessionId
  // 组件可能先卸载（面板切走/场景关闭），异步续体不得再写 store。
  const mountedRef = React.useRef(true)
  React.useEffect(() => () => { mountedRef.current = false }, [])

  return React.useCallback(() => {
    if (busyRef.current) return
    busyRef.current = true
    void (readClipboardOverride ?? clipboardReader)()
      .then(content => {
        if (!mountedRef.current) return
        if (sessionRef.current !== sessionId) return
        if (content === null) {
          setNotice({ text: t('input-clipboard-empty'), failure: false })
          return
        }
        if (content.kind === 'unavailable') {
          setNotice({
            text: t(content.wsl === true ? 'input-clipboard-unavailable-wsl' : 'input-clipboard-unavailable'),
            failure: false,
          })
          return
        }
        if (content.kind !== 'text') {
          // 图片/文件没有 btw 的文本形态：明确提示，不落到任何输入框。
          setNotice({ text: t('question-paste-not-text'), failure: false })
          return
        }
        // 单行框：换行/控制符压成空格，ANSI 序列整段剥掉（用户可控字节）。
        // 只剩空白的粘贴没有可插入的内容（与问卷面板同判据）。
        const text = flattenPasteInline(content.text)
        if (text.trim() === '') {
          setNotice({ text: t('input-clipboard-empty'), failure: false })
          return
        }
        const draft = btwThreads.get(sessionId)?.draft ?? ''
        const next = insertBtwPaste(draft, caretRef.current, text)
        btwThreads.setDraft(sessionId, next.text)
        setCaret(next.caret)
        setNotice(null)
      })
      .catch(() => {
        if (mountedRef.current) setNotice({ text: t('input-clipboard-read-failed'), failure: true })
      })
      .finally(() => { busyRef.current = false })
  }, [sessionId, caretRef, setCaret, setNotice, readClipboardOverride])
}
