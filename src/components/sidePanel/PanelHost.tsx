/**
 * PanelHost（设计文档 §6.3 + v2.1 修订）：
 * - 计算 bounds 并以 PanelProps 传入；为 Panel 子树再嵌套一层
 *   TerminalSizeContext（columns = panel width），现有组件直接放进来
 *   就能拿到正确宽度。
 * - 每个 Panel 独立 PanelErrorBoundary（registrationId 重挂）。
 * - mountPolicy（v2.1）：active=只挂 active（插件默认）；enabled=启用
 *   即挂载，非 active 时 display:none + focused/visible=false——状态
 *   保留但不动画、不收键（内置 todo/jobs/agents/companion）。
 * - 不自动包 ScrollBox（v2.1）：滚动由 Panel 自己决定（右栏内的
 *   ScrollBox 按命中节点接收滚轮）。
 * - 打开某 Panel 时清它的 badge（soft follow：后台更新只亮点不切换）。
 * - 键盘：焦点在右栏时，useSidePanel 先经 SidePanelRuntime.dispatchKey
 *   问活动 Panel（usePanelInput 注册），Panel 没吃才轮到宿主回退键。
 * - 不知道 Chat 消息、输入、Thinking、工具。
 */
import React from 'react'
import { Box, Text } from '../../ui.js'
import { t } from '../../i18n.js'
import { TerminalSizeContext } from '../../ink/components/TerminalSizeContext.js'
import { useTerminalSize } from '../../ink/hooks/use-terminal-size.js'
import type { ChannelUi } from '../../adapter/channel/ui-policy.js'
import { panelStore } from './PanelStore.js'
import { PanelContext, SidePanelRuntimeContext } from './SidePanelRuntimeContext.js'
import { PanelErrorBoundary } from './PanelErrorBoundary.js'
import type { PanelEntry } from './types.js'
import type { SidePanelController } from './useSidePanel.js'

export interface PanelHostProps {
  readonly controller: SidePanelController
  readonly channel: ChannelUi
  readonly width: number
  readonly height: number
  readonly activity?: import('../../dsh-adapter/activity-store.js').ActivityView
  readonly attention?: { readonly approvals: number; readonly questions: number }
  /** 会话轨迹投影（Chat 折好的那一份；轨迹 Panel 直接渲染）。 */
  readonly trajectory?: import('../../dsh-adapter/trajectory/index.js').TrajBuild
  /** 宿主「全屏」出口（PanelBar 的 ⤢ 经 SidePanelColumn 传进来）。 */
  readonly openFullscreen?: (panelId: string) => void
}

function TooNarrow({ minColumns }: { readonly minColumns: number }): React.ReactNode {
  return (
    <Box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center" paddingX={1}>
      <Text dimColor wrap="truncate-end">{t('panel-too-narrow', { min: minColumns })}</Text>
    </Box>
  )
}

/** 插件 Panel 连续崩溃后的会话内禁用卡（§18.4）：不再挂载插件组件，只
 * 提示原因；toast 一次（每 Panel 每会话）。 */
const disabledToasted = new Set<string>()
function PluginDisabled({ panelId, channel }: { readonly panelId: string; readonly channel: ChannelUi }): React.ReactNode {
  React.useEffect(() => {
    if (disabledToasted.has(panelId)) return
    disabledToasted.add(panelId)
    channel.notify(t('panel-plugin-disabled-toast'))
  }, [panelId, channel])
  return (
    <Box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center" paddingX={1}>
      <Text color="warning">{t('panel-plugin-disabled')}</Text>
      <Box height={1} />
      <Text dimColor wrap="truncate-end">{t('panel-plugin-disabled-hint')}</Text>
    </Box>
  )
}

export function PanelHost({ controller, channel, width, height, activity, attention, trajectory, openFullscreen }: PanelHostProps): React.ReactNode {
  const entries = React.useSyncExternalStore(panelStore.subscribe, () => panelStore.list())
  // Forward the real screen rows so panel animations (useAnimationFrame →
  // useTerminalViewport) measure visibility against the screen, not the
  // host's narrowed rows.
  const parentSize = useTerminalSize()
  const screenRows = parentSize.screenRows ?? parentSize.rows
  const enabledIds = controller.enabledPanelIds
  // 只画「已启用 ∩ 已注册」的 Panel，顺序 = 设置里的启用顺序。
  const visibleEntries = React.useMemo(
    () => enabledIds
      .map(id => entries.find(entry => entry.definition.id === id))
      .filter((entry): entry is PanelEntry => entry !== undefined),
    [enabledIds, entries],
  )
  const activeEntry = visibleEntries.find(entry => entry.definition.id === controller.activePanelId)
    ?? visibleEntries[0]

  // Soft follow：后台更新只亮 PanelBar 状态点；用户打开该 Panel 时清零。
  const activeId = activeEntry?.definition.id
  React.useEffect(() => {
    if (activeId !== undefined) panelStore.clearBadge(activeId)
  }, [activeId])

  const mode = controller.zoom ? 'zoom' : 'split'
  const runtimeContext = React.useMemo(
    () => ({ runtime: controller.runtime, channel, activity, attention, trajectory, openFullscreen }),
    [controller.runtime, channel, activity, attention, trajectory, openFullscreen],
  )

  return (
    <SidePanelRuntimeContext.Provider value={runtimeContext}>
      {visibleEntries.map(entry => {
        const def = entry.definition
        const isActive = activeEntry !== undefined && def.id === activeEntry.definition.id
        if (!isActive && def.mountPolicy !== 'enabled') return null
        if (entry.disabled === true) {
          return (
            <Box
              key={def.id}
              flexDirection="column"
              flexGrow={1}
              overflow="hidden"
              display={isActive ? 'flex' : 'none'}
            >
              <PluginDisabled panelId={def.id} channel={channel} />
            </Box>
          )
        }
        const tooNarrow = def.minColumns !== undefined && width < def.minColumns
        const body = tooNarrow ? (
          <TooNarrow minColumns={def.minColumns!} />
        ) : (
          <PanelErrorBoundary key={entry.registrationId} panelId={def.id}>
            <PanelContext.Provider value={{ panelId: def.id }}>
              <TerminalSizeContext.Provider value={{ columns: width, rows: height, screenRows }}>
                {React.createElement(def.component, {
                  width,
                  height,
                  focused: controller.focus === 'panel' && isActive,
                  visible: isActive,
                  mode,
                })}
              </TerminalSizeContext.Provider>
            </PanelContext.Provider>
          </PanelErrorBoundary>
        )
        return (
          <Box
            key={def.id}
            flexDirection="column"
            flexGrow={1}
            overflow="hidden"
            display={isActive ? 'flex' : 'none'}
          >
            {body}
          </Box>
        )
      })}
    </SidePanelRuntimeContext.Provider>
  )
}
