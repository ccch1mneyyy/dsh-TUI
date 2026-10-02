/**
 * PluginPanelAdapter（设计文档 §18.2/§18.5）：把插件注册的 Panel 组件
 * 接进 PanelHost。PanelHost 看到的仍是普通 PanelDefinition.component
 * （这里在注册时包好），插件组件拿到的是收窄后的
 * TuiPanelProps { React, ui, host, width, height, focused, visible, mode }。
 *
 * - ui：照 TuiStatusViewUi 的收窄法——Box 去掉 ref/tabIndex/focus/键盘/
 *   contextMenu（保留 click/hover/drag/onWheel），useTerminalSize 恒等于
 *   Panel 的 width/height，useAnimationTime 是唯一合法定时源。
 * - host：策展只读 snapshot（SidePanelRuntimeContext 的 channel/activity/
 *   attention 的结构拷贝，不含转录正文/凭证/文件内容）+ badge/scene/toast/
 *   storage/focus/onKey。
 * - onKey：走 usePanelInput 分发器（v2.1 键盘契约），仅 focused 期间投递；
 *   preventDefault() = 阻止宿主回退键（等价 handler 返回 true）。
 * - sendToChat：本阶段授权流程（panels.chat.attach）未落地——返回 false
 *   并 toast 一次（i18n 文案），不静默。
 */
import React from 'react'
import { Box, Text, Image, ScrollBox, useTheme, useAnimationFrame } from '../../ui.js'
import { Divider } from '../design-system/Divider.js'
import { t, getLang } from '../../i18n.js'
import { SidePanelRuntimeContext } from './SidePanelRuntimeContext.js'
import { usePanelInput } from './usePanelInput.js'
import { panelStore } from './PanelStore.js'
import type { PanelProps } from './types.js'
import type {
  TuiPanelHostApi,
  TuiPanelKeyEvent,
  TuiPanelProps,
  TuiPanelSnapshot,
  TuiPanelUi,
} from '../../dsh-adapter/panels.js'
import {
  pluginPanelFocus,
  pluginPanelOpenScene,
  pluginPanelStorage,
  pluginPanelToast,
} from '../../dsh-adapter/panel-runtime-registry.js'
import type { SidePanelKeyFlags } from './types.js'

/** sendToChat 未授权提示每 Panel 每会话只 toast 一次。 */
const sendToChatWarned = new Set<string>()

export function makePluginPanelComponent(
  panelId: string,
  component: React.ComponentType<TuiPanelProps>,
): React.ComponentType<PanelProps> {
  function PluginPanelHost(props: PanelProps): React.ReactNode {
    const { width, height, focused, visible, mode } = props
    const runtimeCtx = React.useContext(SidePanelRuntimeContext)

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

    // ── host API：identity 随 runtimeCtx（channel/activity/attention）
    // 与 focused 变化而刷新；其余函数绑定 panelId。
    const channel = runtimeCtx?.channel
    const activity = runtimeCtx?.activity
    const attention = runtimeCtx?.attention
    const host = React.useMemo<TuiPanelHostApi>(() => ({
      snapshot: (): TuiPanelSnapshot => {
        // 结构拷贝、只策展白名单字段——不含转录正文/凭证/文件内容。
        return Object.freeze({
          sessionId: channel?.sessionId ?? '',
          cwd: channel?.cwd ?? '',
          lang: getLang(),
          working: channel?.working === true,
          spinnerMode: channel?.spinnerMode ?? 'idle',
          version: channel?.version ?? 0,
          goal: channel?.goal === undefined
            ? undefined
            : Object.freeze({
              objective: channel.goal.objective,
              phase: channel.goal.phase,
              roundsStarted: channel.goal.roundsStarted,
              maxGoalRounds: channel.goal.maxGoalRounds,
            }),
          todos: Object.freeze((channel?.todos ?? []).map(item => Object.freeze({
            content: item.content,
            status: item.status,
          }))),
          backgroundJobs: Object.freeze((channel?.backgroundJobs ?? []).map(job => Object.freeze({
            id: job.id,
            kind: job.kind,
            label: job.label,
            status: job.status,
            progress: job.progress,
            detail: job.detail,
            startedAt: job.startedAt,
          }))),
          subagents: Object.freeze((channel?.subagents ?? []).map(sub => Object.freeze({
            agentId: sub.agentId,
            description: sub.description,
            status: sub.status,
            mode: sub.mode,
            model: sub.model,
            startedAt: sub.startedAt,
            completedAt: sub.completedAt,
          }))),
          attention: Object.freeze({
            approvals: attention?.approvals ?? 0,
            questions: attention?.questions ?? 0,
          }),
          activity: activity === undefined ? undefined : Object.freeze({ ...activity }),
        }) as TuiPanelSnapshot
      },
      focused,
      notify: (level, unread = 0) => { panelStore.setBadge(panelId, { level, unread }) },
      clearBadge: () => { panelStore.clearBadge(panelId) },
      sendToChat: () => {
        if (!sendToChatWarned.has(panelId)) {
          sendToChatWarned.add(panelId)
          pluginPanelToast(panelId, t('panel-send-to-chat-denied'))
        }
        return false
      },
      openScene: sceneId => pluginPanelOpenScene(panelId, sceneId),
      toast: text => pluginPanelToast(panelId, text),
      get storage() { return pluginPanelStorage(panelId) },
      onKey: listener => {
        keyListeners.current.add(listener)
        return () => { keyListeners.current.delete(listener) }
      },
      focus: () => pluginPanelFocus(panelId),
    }), [channel, activity, attention, focused])

    // ── ui kit：useTerminalSize/useAnimationTime 绑定 Panel 尺寸，其余
    // 直接复用宿主组件（类型在 TuiPanelUi 处收窄）。
    const ui = React.useMemo<TuiPanelUi>(() => ({
      Box: Box as TuiPanelUi['Box'],
      Text: Text as TuiPanelUi['Text'],
      Image: Image as TuiPanelUi['Image'],
      ScrollBox: ScrollBox as TuiPanelUi['ScrollBox'],
      Divider: Divider as TuiPanelUi['Divider'],
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
