/**
 * PluginPanelAdapter（设计文档 §18.2/§18.5）：把插件注册的 Panel 组件
 * 接进 PanelHost。PanelHost 看到的仍是普通 PanelDefinition.component
 * （这里在注册时包好），插件组件拿到的是收窄后的
 * TuiPanelProps { React, ui, host, width, height, focused, visible, mode }。
 *
 * - ui：照 TuiStatusViewUi 的收窄法——Box 去掉 ref/tabIndex/focus/键盘/
 *   contextMenu（保留 click/hover/drag/onWheel），useTerminalSize 恒等于
 *   Panel 的 width/height，useAnimationTime 是唯一合法定时源；可视化套件
 *   （tuiChartKit）整份展开进来，与场景、状态视图是同一个实现。
 * - host：策展只读 snapshot（含 usage；panelSnapshot.ts，与场景共用）+
 *   badge/storage/focus/onKey + 共用导航动词（surface-host.ts：openSession/
 *   openFile/copy/openScene/openPanel/useParams/toast）。
 * - onKey：走 usePanelInput 分发器（v2.1 键盘契约），仅 focused 期间投递；
 *   preventDefault() = 阻止宿主回退键（等价 handler 返回 true）。
 * - sendToChat：本阶段授权流程（panels.chat.attach）未落地——返回 false
 *   并 toast 一次（i18n 文案），不静默。
 * - compact：makePluginPanelCompactComponent 把 PanelCompactProps 适配成
 *   TuiPanelCompactProps（Box/Text + 单行可视化子集 + 同一份策展 snapshot），
 *   memo 包装，props 不变不重渲染。
 */
import React from 'react'
import { Box, Text, Image, ScrollBox, useTheme, useAnimationFrame } from '../../ui.js'
import { Divider } from '../design-system/Divider.js'
import { tuiChartKit, tuiChartRowKit } from '../design-system/chartKit.js'
import { TerminalWriteContext } from '../../ink/useTerminalNotification.js'
import { PanelCodeBlock, PanelMarkdown } from './panelMarkdown.js'
import { t } from '../../i18n.js'
import { SidePanelRuntimeContext } from './SidePanelRuntimeContext.js'
import { usePanelInput } from './usePanelInput.js'
import { panelStore } from './PanelStore.js'
import { buildPanelSnapshot } from './panelSnapshot.js'
import type { PanelCompactProps, PanelProps } from './types.js'
import type {
  TuiPanelCompactProps,
  TuiPanelCompactUi,
  TuiPanelHostApi,
  TuiPanelKeyEvent,
  TuiPanelProps,
  TuiPanelUi,
} from '../../dsh-adapter/panels.js'
import {
  isLivePanelRegistration,
  pluginPanelCopy,
  pluginPanelFocus,
  pluginPanelOpenFile,
  pluginPanelOpenPanel,
  pluginPanelOpenScene,
  pluginPanelOpenSession,
  pluginPanelStorage,
  pluginPanelToast,
  usePluginPanelParams,
  type PanelOwnerRecord,
} from '../../dsh-adapter/panel-runtime-registry.js'
import type { SidePanelKeyFlags } from './types.js'

/** sendToChat 未授权提示每 Panel 每会话只 toast 一次。 */
const sendToChatWarned = new Set<string>()

/** `registration` is the owner record of the registration making this
 *  component: every host verb is bound to it (panel-runtime-registry.ts). */
export function makePluginPanelComponent(
  panelId: string,
  component: React.ComponentType<TuiPanelProps>,
  registration: PanelOwnerRecord,
): React.ComponentType<PanelProps> {
  function PluginPanelHost(props: PanelProps): React.ReactNode {
    const { width, height, focused, visible, mode } = props
    const runtimeCtx = React.useContext(SidePanelRuntimeContext)
    const writeRaw = React.useContext(TerminalWriteContext)

    // ── onKey（v2.1 分发器）：仅 focused && visible 期间投递。listener
    // 集合在分发时读取，插件在 render 期或 effect 期注册都安全。
    const keyListeners = React.useRef(new Set<(event: TuiPanelKeyEvent) => void>())
    usePanelInput((input, key: SidePanelKeyFlags) => {
      let consumed = false
      const event: TuiPanelKeyEvent = {
        input,
        key,
        preventDefault: () => { consumed = true },
      }
      for (const listener of [...keyListeners.current]) {
        try {
          listener(event)
        } catch {
          // 插件 listener 崩溃不得打断后续分发（错误面由 boundary 兜）。
        }
      }
      return consumed
    }, { active: focused && visible })

    // ── host API：identity 随 runtimeCtx（channel/activity/attention 计数）
    // 与 focused 变化而刷新；其余函数绑定这次注册（撤下或重注册后一律拒绝）。attention 按两个计数
    // 记忆——Chat 每次渲染都会给一个新对象，不能让 host 每帧换身份。
    const channel = runtimeCtx?.channel
    const activity = runtimeCtx?.activity
    const approvals = runtimeCtx?.attention?.approvals ?? 0
    const questions = runtimeCtx?.attention?.questions ?? 0
    const host = React.useMemo<TuiPanelHostApi>(() => ({
      // 结构拷贝、只策展白名单字段——不含转录正文/凭证/文件内容。
      // Revoked with the registration like every verb below.
      snapshot: () => isLivePanelRegistration(registration)
        ? buildPanelSnapshot(channel, activity, { approvals, questions })
        : buildPanelSnapshot(undefined, undefined, { approvals: 0, questions: 0 }),
      focused,
      notify: (level, unread = 0) => { if (isLivePanelRegistration(registration)) panelStore.setBadge(panelId, { level, unread }) },
      clearBadge: () => { if (isLivePanelRegistration(registration)) panelStore.clearBadge(panelId) },
      sendToChat: () => {
        if (!sendToChatWarned.has(panelId)) {
          sendToChatWarned.add(panelId)
          pluginPanelToast(registration, t('panel-send-to-chat-denied'))
        }
        return false
      },
      openScene: (sceneId, params) => pluginPanelOpenScene(registration, sceneId, params),
      openPanel: (targetId, params) => pluginPanelOpenPanel(registration, targetId, params),
      openSession: sessionId => pluginPanelOpenSession(registration, channel, sessionId),
      // 相对路径按调用时的会话 cwd 解析（不是渲染时的：会话可能已经切换）。
      openFile: (path, options) => pluginPanelOpenFile(registration, channel?.cwd, path, options),
      copy: text => pluginPanelCopy(registration, text, writeRaw, channel === undefined ? undefined : message => { channel.notify(message, { timeoutMs: 1500 }) }),
      useParams: () => usePluginPanelParams(panelId),
      toast: text => pluginPanelToast(registration, text),
      get storage() { return pluginPanelStorage(registration) },
      onKey: listener => {
        keyListeners.current.add(listener)
        return () => { keyListeners.current.delete(listener) }
      },
      focus: () => pluginPanelFocus(registration),
    }), [channel, activity, approvals, questions, focused, writeRaw])

    // ── ui kit：useTerminalSize/useAnimationTime 绑定 Panel 尺寸，其余
    // 直接复用宿主组件（类型在 TuiPanelUi 处收窄）；Markdown/CodeBlock 是
    // panelMarkdown 里的收窄包装，可视化套件是 chartKit 的同一份对象。
    // 新成员若依赖 host/focused，必须同步下面的依赖数组，否则会读到陈旧闭包。
    const ui = React.useMemo<TuiPanelUi>(() => ({
      ...tuiChartKit,
      Box: Box as TuiPanelUi['Box'],
      Text: Text as TuiPanelUi['Text'],
      Image: Image as TuiPanelUi['Image'],
      ScrollBox: ScrollBox as TuiPanelUi['ScrollBox'],
      Divider: Divider as TuiPanelUi['Divider'],
      Markdown: PanelMarkdown,
      CodeBlock: PanelCodeBlock,
      useTerminalSize: () => ({ columns: width, rows: height }),
      useAnimationTime: (intervalMs: number | null) => useAnimationFrame(intervalMs)[1],
      useTheme: useTheme as TuiPanelUi['useTheme'],
    }), [width, height])

    return React.createElement(component, {
      React,
      ui,
      host,
      width,
      height,
      focused,
      visible,
      mode,
    })
  }
  PluginPanelHost.displayName = 'PluginPanelHost(' + panelId + ')'
  return PluginPanelHost
}

/** compact 行的 kit 是静态的（没有尺寸/时钟绑定），所有面板共用一份。 */
const COMPACT_UI: TuiPanelCompactUi = Object.freeze({
  ...tuiChartRowKit,
  Box: Box as TuiPanelCompactUi['Box'],
  Text: Text as TuiPanelCompactUi['Text'],
})

/** 把插件的 compact 组件接进 PanelCompactRows（宿主挂在提示框上方）。
 *  memo：Chat 每个流式 delta 都会重渲染 compact 槽，props（width、badge、
 *  snapshot）没变就不进插件代码。 */
export function makePluginPanelCompactComponent(
  panelId: string,
  component: React.ComponentType<TuiPanelCompactProps>,
): React.ComponentType<PanelCompactProps> {
  function PluginPanelCompactHost({ width, badge, snapshot }: PanelCompactProps): React.ReactNode {
    // store 只在 level/unread 变化时换 badge 对象：由它派生插件那份（冻结，
    // 不带 latestAt），身份随之稳定。
    const pluginBadge = React.useMemo(
      () => (badge === null ? null : Object.freeze({ level: badge.level, unread: badge.unread })),
      [badge],
    )
    return React.createElement(component, {
      React,
      ui: COMPACT_UI,
      width,
      badge: pluginBadge,
      snapshot,
    })
  }
  PluginPanelCompactHost.displayName = 'PluginPanelCompactHost(' + panelId + ')'
  return React.memo(PluginPanelCompactHost)
}
