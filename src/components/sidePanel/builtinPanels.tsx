/**
 * 内置 Panel 注册（设计文档 §16.3：内置与插件从第一天走同一个
 * PanelStore.register；source 只是标记）。模块首次导入时注册——
 * SidePanelColumn 引用本模块，所以任何挂到侧栏的树（含回归夹具）
 * 都会自动带上内置 Panel；插件 Panel 在 Phase 6 经准入外壳进同一个
 * store。
 */
import React from 'react'
import { t } from '../../i18n.js'
import { GoalTodoPanel } from '../GoalTodoPanel.js'
import { JobsPanel } from '../JobsPanel.js'
import { SubagentDashboard } from '../SubagentDashboard.js'
import { SubagentDetailScene } from '../SubagentDetailScene.js'
import { CompanionPanel } from './companion/CompanionPanel.js'
import { InfoPanel } from './InfoPanel.js'
import { TrajectoryPanel } from './TrajectoryPanel.js'
import { WorkspacePanel } from './WorkspacePanel.js'
import { BtwPanelAdapter } from './btw/BtwPanelAdapter.js'
import { panelStore } from './PanelStore.js'
import { useSidePanelChannel } from './SidePanelRuntimeContext.js'
import { usePanelInput } from './usePanelInput.js'
import { jobsFocusStore } from './jobsFocusStore.js'
import { agentViewStore } from './agentViewStore.js'
import { agentComposeTargetOf, type AgentComposeTarget } from '../messages/agentTeam.js'
import type { PanelProps } from './types.js'

/** todo：GoalTodoPanel 的 panel variant（同一份 store，不重写业务）。 */
function TodoPanelAdapter({ width, height, focused, visible }: PanelProps): React.ReactNode {
  const channel = useSidePanelChannel()
  // 折叠态是面板内局部 state（默认展开）——不接 Chat 的 ctrl/cmd+q 热键
  // 状态，两个形态各自独立。头部行点击与键盘（Enter/空格）走同一 toggle：
  // 修复前头部行 onClick 没接（GoalTodoPanel 的 onToggle 未传），
  // 侧栏里点折叠头是死控件。
  const [collapsed, setCollapsed] = React.useState(false)
  const toggleCollapsed = React.useCallback(() => setCollapsed(previous => !previous), [])
  usePanelInput((input, key) => {
    if (key.ctrl || key.meta || key.escape) return false
    if (key.return_ !== true && input !== ' ') return false
    toggleCollapsed()
    return true
  }, { active: focused && visible })
  // 行数预算：goal 区最多 2 行 + 折叠头 1 行 + 留白 1 行，其余给 todo 列表。
  return (
    <GoalTodoPanel
      channel={channel}
      variant="panel"
      visible={visible}
      collapsed={collapsed}
      onToggle={toggleCollapsed}
      maxTodos={Math.max(3, height - 4)}
      // 折行宽 = 面板宽 − 左右 padding 2 − 树形前缀 3 − 状态 glyph 2，
      // 再留 1 格余量防 ink 二次折行（长行溢出超过约束会把同行定宽列挤折）。
      wrapWidth={Math.max(10, width - 8)}
    />
  )
}

/**
 * jobs：JobsPanel 的 panel variant（同一份 roster/kill 语义，布局与
 * 键盘按侧栏契约重排）。badge 派生：running>0 → info；面板不可见
 * 期间新出现的 failed → error（unread 计数）；两者皆无 → 清空。
 * 面板可见时把当前 failed 集合记为已读并清 badge（running 仍亮点）。
 */
function JobsPanelAdapter({ focused, visible }: PanelProps): React.ReactNode {
  const channel = useSidePanelChannel()
  const jobs = channel.backgroundJobs
  const version = channel.version
  const focusRequest = React.useSyncExternalStore(jobsFocusStore.subscribe, jobsFocusStore.get)
  // A backend whose job output is read on demand keeps the focused job's
  // tail fresh while this panel shows it (the same seam the full-screen
  // panel and the transcript cards use); one identity per capability.
  const jobControlRef = React.useRef(channel.jobControl)
  jobControlRef.current = channel.jobControl
  const outputWatchable = typeof channel.jobControl?.watchOutput === 'function'
  const watchOutput = React.useMemo(
    () => outputWatchable ? (id: string) => jobControlRef.current?.watchOutput?.(id) ?? (() => undefined) : undefined,
    [outputWatchable],
  )
  // 已读基线：上次 visible=true 时见过的 failed id 集合。
  const seenFailedRef = React.useRef<ReadonlySet<string>>(new Set())
  React.useEffect(() => {
    const running = jobs.filter(job => job.status === 'running' || job.status === 'stopping').length
    const failedIds = new Set(jobs.filter(job => job.status === 'failed').map(job => job.id))
    if (visible) {
      seenFailedRef.current = failedIds
      panelStore.setBadge('jobs', running > 0 ? { level: 'info', unread: 0 } : null)
      return
    }
    let unread = 0
    for (const id of failedIds) if (!seenFailedRef.current.has(id)) unread += 1
    panelStore.setBadge(
      'jobs',
      unread > 0 ? { level: 'error', unread } : running > 0 ? { level: 'info', unread: 0 } : null,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- badge derives from the channel version bump
  }, [version, visible])
  return (
    <JobsPanel
      jobs={jobs}
      variant="panel"
      focused={focused}
      visible={visible}
      focusRequest={focusRequest}
      onWatchOutput={watchOutput}
      onKill={(id: string) => {
        // Stub channels (verify harnesses) have no jobControl — surface
        // the same failure toast as a refused kill instead of throwing.
        if (channel.jobControl?.kill(id) !== true) {
          channel.notify(t('jobs-kill-failed', { id }), { color: 'error' })
        }
      }}
      onSendToChat={(job) => {
        // Send to Chat（§6.7）：任务摘要附为下一次提交的上下文；chip 在
        // 输入框上方出现，Esc 可撤、提交即消耗。
        if (typeof channel.attachContext !== 'function') return
        const lines = job.outputLines ?? []
        const summary = [
          `后台任务 ${job.id}（${job.status}）`,
          job.command !== undefined && job.command !== '' ? `命令：${job.command}` : `命令：${job.label}`,
          lines.length > 0
            ? `输出（末 ${Math.min(10, lines.length)} 行）：\n${lines.slice(-10).map(line => line.text).join('\n')}`
            : '（暂无输出）',
        ].join('\n')
        channel.attachContext({ source: 'panel', sourceId: job.id, title: `Job ${job.id}`, content: summary })
        channel.notify(t('panel-sent-to-chat', { title: job.id }), { color: 'success' })
      }}
    />
  )
}

/** agents 面板的二级路由：dashboard ↔ detail。 */
type AgentsRoute = 'dashboard' | { readonly detail: string }

/** 路由的跨挂载记忆（design §4.1「Panel route 不丢」）：主屏 Agent View 盖过
 *  Chat 时整棵主树（含本面板）卸载，重挂载从这里恢复最后路由。 */
let lastAgentsRoute: AgentsRoute = 'dashboard'

/**
 * agents：SubagentDashboard / SubagentDetailScene 的 panel variant——同一份
 * channel.subagents 与 subagentControl，布局与键盘按侧栏契约重排。二级路由
 * 是组件内 state：mountPolicy:'enabled' 让它在切面板 / 收侧栏时保留（评审
 * §四的硬需求）。badge 派生：running/starting>0 → info；面板不可见期间新
 * 出现的 failed → error（unread 计数）；两者皆无 → 清空；可见时把当前
 * failed 集合记为已读。
 */
function AgentsPanelAdapter({ focused, visible }: PanelProps): React.ReactNode {
  const channel = useSidePanelChannel()
  const subagents = channel.subagents
  const version = channel.version
  const [route, setRoute] = React.useState<AgentsRoute>(lastAgentsRoute)
  React.useEffect(() => { lastAgentsRoute = route }, [route])
  // agent-team 能力面：通道的 subagentControl.message 成员（缺失 = 无此面，
  // 不渲染 composer/Messages 数据）。
  // 可选链兜底：无 subagentControl 的桩 channel（回归夹具）不炸渲染。
  const messageControl = channel.subagentControl?.message
  const detailAgentId = typeof route === 'object' ? route.detail : null
  const detailMessages = detailAgentId !== null && messageControl !== undefined
    ? messageControl.messages().filter(m => m.from === detailAgentId || m.to === detailAgentId)
    : []
  const detailTarget: AgentComposeTarget | undefined = React.useMemo(() => {
    if (detailAgentId === null) return undefined
    const labels = new Map(subagents.map(s => [s.agentId, s.description]))
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- roster may lag the route
    return labels.has(detailAgentId) ? agentComposeTargetOf(detailAgentId, labels) : undefined
  }, [detailAgentId, subagents])
  const detailCompose = detailTarget !== undefined && messageControl !== undefined
    ? { control: messageControl, target: detailTarget }
    : undefined
  // 已读基线：上次 visible=true 时见过的 failed id 集合。
  const seenFailedRef = React.useRef<ReadonlySet<string>>(new Set())
  React.useEffect(() => {
    const running = subagents.filter(s => s.status === 'running' || s.status === 'starting').length
    const failedIds = new Set(subagents.filter(s => s.status === 'failed').map(s => s.agentId))
    if (visible) {
      seenFailedRef.current = failedIds
      panelStore.setBadge('agents', running > 0 ? { level: 'info', unread: 0 } : null)
      return
    }
    let unread = 0
    for (const id of failedIds) if (!seenFailedRef.current.has(id)) unread += 1
    panelStore.setBadge(
      'agents',
      unread > 0 ? { level: 'error', unread } : running > 0 ? { level: 'info', unread: 0 } : null,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- badge derives from the channel version bump
  }, [version, visible])

  // 行暂时不在名册里（会话切换 / replay 尚未回填）时退回 dashboard，但不清
  // 路由：行回来后用户原来看的那一页还在——这正是 enabled 挂载策略要保的
  // 状态。
  const detail = typeof route === 'object'
    ? subagents.find(s => s.agentId === route.detail)
    : undefined
  if (typeof route === 'object' && detail !== undefined) {
    return (
      <SubagentDetailScene
        subagent={detail}
        variant="panel"
        focused={focused}
        visible={visible}
        onBack={() => setRoute('dashboard')}
        onInterrupt={(id: string) => channel.subagentControl?.interrupt(id)}
        {...(channel.subagentControl?.history === undefined ? {} : { loadTranscript: channel.subagentControl.history })}
        onOpenView={() => agentViewStore.request(detail.agentId, 'agent-detail', true)}
        messages={detailMessages}
        {...(detailCompose === undefined ? {} : { compose: detailCompose })}
      />
    )
  }
  return (
    <SubagentDashboard
      subagents={subagents}
      variant="panel"
      focused={focused}
      visible={visible}
      onSelect={(id: string) => setRoute({ detail: id })}
      onOpenView={(id: string) => agentViewStore.request(id, 'agents-dashboard', true)}
      messages={messageControl?.messages()}
    />
  )
}

let registered = false

/** 幂等：重复调用（夹具多次挂载）不再注册。 */
export function registerBuiltinPanels(): void {
  if (registered) return
  registered = true
  panelStore.register({
    id: 'todo',
    titleKey: 'panel-title-todo',
    icon: '≡',
    order: 10,
    source: 'builtin',
    mountPolicy: 'enabled',
    defaultEnabled: true,
    component: TodoPanelAdapter,
  }, 'builtin')
  panelStore.register({
    id: 'jobs',
    titleKey: 'panel-title-jobs',
    icon: '▸',
    order: 20,
    source: 'builtin',
    mountPolicy: 'enabled',
    defaultEnabled: true,
    minColumns: 28,
    // 整屏对应物 = /jobs 的整屏 JobsPanel；PanelBar 右端因此有 ⤢ 全屏按钮。
    capabilities: { scroll: true, sendToChat: true, fullscreen: true },
    component: JobsPanelAdapter,
  }, 'builtin')
  panelStore.register({
    id: 'agents',
    titleKey: 'panel-title-agents',
    icon: '◆',
    order: 30,
    source: 'builtin',
    mountPolicy: 'enabled',
    defaultEnabled: true,
    // 整屏对应物 = Ctrl+A 的 SubagentDashboard。
    capabilities: { scroll: true, fullscreen: true },
    component: AgentsPanelAdapter,
  }, 'builtin')
  panelStore.register({
    id: 'info',
    titleKey: 'panel-title-info',
    icon: 'ⓘ',
    order: 15,
    source: 'builtin',
    mountPolicy: 'enabled',
    // opt-in（在 dsh-tui.sidePanel.panels 里加入才出现，同 companion）。
    defaultEnabled: false,
    minColumns: 24,
    capabilities: { scroll: true },
    component: InfoPanel,
  }, 'builtin')
  panelStore.register({
    id: 'trajectory',
    titleKey: 'panel-title-trajectory',
    icon: '∿',
    order: 25,
    source: 'builtin',
    mountPolicy: 'enabled',
    defaultEnabled: false,
    minColumns: 28,
    // 整屏对应物 = Ctrl+T / /trace 的 TrajectoryScene（分屏时那两者也走本面板）。
    capabilities: { scroll: true, fullscreen: true },
    component: TrajectoryPanel,
  }, 'builtin')
  panelStore.register({
    id: 'workspace',
    titleKey: 'panel-title-workspace',
    icon: '⌗',
    order: 35,
    source: 'builtin',
    mountPolicy: 'enabled',
    defaultEnabled: false,
    minColumns: 28,
    // 整屏对应物 = /home 的工作区主页（分屏时 /home 也走本面板）。
    capabilities: { scroll: true, fullscreen: true },
    component: WorkspacePanel,
  }, 'builtin')
  panelStore.register({
    id: 'btw',
    titleKey: 'panel-title-btw',
    icon: '?',
    order: 22,
    source: 'builtin',
    mountPolicy: 'enabled',
    // opt-in（/btw 快路径在未启用时回退浮层，启用后路由进面板）。
    defaultEnabled: false,
    minColumns: 28,
    // 整屏对应物 = ⤢ 的 BtwThreadScene（Esc 返回侧栏，不清 thread/draft）。
    capabilities: { scroll: true, sendToChat: true, fullscreen: true },
    component: BtwPanelAdapter,
  }, 'builtin')
  panelStore.register({
    id: 'companion',
    titleKey: 'panel-title-companion',
    icon: '♥',
    order: 40,
    source: 'builtin',
    mountPolicy: 'enabled',
    // 默认不启用（在 dsh-tui.sidePanel.panels 里显式加入才出现）。
    defaultEnabled: false,
    component: CompanionPanel,
  }, 'builtin')
}
