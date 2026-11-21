/**
 * PluginsPanel — 侧栏「插件」面板：分组列出 profile 的 bundle，支持
 * 键盘/鼠标导航、行内详情展开与右键操作菜单（启用/禁用/卸载/详情）。
 *
 * 数据来源：channel.pluginPanelBundles()（异步，挂载时拉取，`plugin-manager/changed`
 * 与写操作结算时后台静默刷新，保持当前滚动与焦点）。
 * 操作复用 Chat.tsx 的现有确认/回滚浮层流程（managePlugin / installPlugin），
 * 面板自身只负责列表浏览、详情展示与右键菜单入口。
 *
 * 分组（Divider 分隔）：
 * - 已安装（extra）：用户手动安装的第三方 bundle
 * - 实验功能（experimental）：安装提供的可选实验 bundle
 * - 基础组件（base）：composition 自带，默认折叠，点击或 Enter 展开
 */
import React from 'react'
import { Box, Text, ScrollBox, type ScrollBoxHandle } from '../../../ui.js'
import type { DOMElement } from '../../../ink/dom.js'
import type { ClickEvent } from '../../../ink/events/click-event.js'
import type { ContextMenuEvent } from '../../../ink/events/context-menu-event.js'
import { getLang, t, type I18nKey } from '../../../i18n.js'
import { truncateWidth } from '../../../sessions/format.js'
import { Divider } from '../../design-system/Divider.js'
import {
  useSidePanelChannel,
  useSidePanelFocusPanel,
  useSidePanelPluginActions,
} from '../SidePanelRuntimeContext.js'
import { usePanelInput } from '../usePanelInput.js'
import { panelStore } from '../PanelStore.js'
import { LoadingState } from '../../design-system/LoadingState.js'
import type { PanelProps } from '../types.js'
import type { PluginPanelBundle } from '../../../adapter/ports/channel-ui.js'
import { pluginPanelServiceAvailable } from './pluginPanelService.js'

type PluginMenuAction = 'enable' | 'disable' | 'remove'

interface PluginContextMenuState {
  readonly bundleName: string
  readonly localCol: number
  readonly localRow: number
  readonly item: number
  readonly actionsKey: string
}

function menuActionsFor(
  bundle: PluginPanelBundle,
  canManage: boolean,
): readonly PluginMenuAction[] {
  const actions: PluginMenuAction[] = []
  if (canManage && bundle.group !== 'base' && bundle.readOnlyReason === undefined) {
    actions.push(bundle.enabled ? 'disable' : 'enable')
  }
  if (canManage && bundle.group !== 'base' && bundle.removable && bundle.readOnlyReason === undefined) {
    actions.push('remove')
  }
  return actions
}

function menuLabelKey(action: PluginMenuAction): I18nKey {
  switch (action) {
    case 'enable': return 'plugins-panel-menu-enable'
    case 'disable': return 'plugins-panel-menu-disable'
    case 'remove': return 'plugins-panel-menu-remove'
  }
}

/** 单行 bundle 呈现。 */
function BundleRow({ bundle, focused, width }: {
  bundle: PluginPanelBundle
  focused: boolean
  width: number
}): React.ReactNode {
  const showVersion = width >= 36
  const statusIcon = bundle.error !== undefined ? '✗'
    : bundle.readOnlyReason !== undefined ? '⚠'
    : bundle.enabled ? '✓' : '·'
  const statusColor = bundle.error !== undefined ? 'error' as const
    : bundle.readOnlyReason !== undefined ? 'warning' as const
    : bundle.enabled ? 'success' as const : undefined
  // 标题列 = 总宽 - pointer(2) - 状态列(2) - 版本列(如有,10) - 间距(1或2)
  const versionWidth = showVersion ? 10 : 0
  const gapWidth = showVersion ? 2 : 1
  const titleWidth = Math.max(6, width - 4 - versionWidth - gapWidth)
  return (
    <Box flexDirection="row" height={1} flexShrink={0} width="100%">
      <Box width={2} flexShrink={0}>
        <Text color={focused ? 'suggestion' : undefined}>{focused ? '❯' : ' '}</Text>
      </Box>
      <Box width={titleWidth} marginRight={1} flexShrink={0} overflow="hidden">
        <Text color={focused ? 'suggestion' : undefined} wrap="truncate-end">
          {bundle.title}
        </Text>
      </Box>
      {showVersion && (
        <Box width={versionWidth} marginRight={1} flexShrink={0} justifyContent="flex-end" overflow="hidden">
          <Text dimColor wrap="truncate-end">{bundle.version ?? ''}</Text>
        </Box>
      )}
      <Box width={2} flexShrink={0} justifyContent="flex-end">
        <Text color={statusColor} dimColor={statusColor === undefined}>{statusIcon}</Text>
      </Box>
    </Box>
  )
}

/** 折叠分组头（仅基础组件使用）。 */
function GroupHeader({ title, count, collapsed, focused }: {
  title: string
  count: number
  collapsed: boolean
  focused: boolean
}): React.ReactNode {
  const icon = collapsed ? '▸' : '▾'
  return (
    <Box flexDirection="row" height={1} flexShrink={0}>
      <Box width={2} flexShrink={0}>
        <Text color={focused ? 'suggestion' : undefined}>{focused ? '❯' : ' '}</Text>
      </Box>
      <Text color={focused ? 'suggestion' : undefined} dimColor={!focused}>{icon} {title} ({count})</Text>
    </Box>
  )
}

/** 空列表占位。 */
function EmptyHint({ message }: { message: string }): React.ReactNode {
  return (
    <Box paddingLeft={2} marginTop={1}>
      <Text dimColor>{message}</Text>
    </Box>
  )
}

/**
 * 宿主没有 profile 插件服务时的说明。与加载失败、空列表分开：这不是错误，
 * 也不是“服务在但没有 bundle”。整块水平/垂直居中；面板太矮时先丢正文，
 * 再丢动作，只保留标题。
 */
function ServiceUnavailable({ width, height, focused, onDiagnostics }: {
  width: number
  height: number
  focused: boolean
  onDiagnostics?: () => void
}): React.ReactNode {
  const compact = height < 10
  const minimal = height < 6
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      flexShrink={0}
      alignItems="center"
      justifyContent={minimal ? 'flex-start' : 'center'}
      paddingLeft={1}
      paddingRight={1}
      overflow="hidden"
    >
      <Text color="warning">⚠</Text>
      <Text color="warning">{t('plugins-panel-unavailable-title')}</Text>
      {!compact && (
        <>
          <Box height={1} />
          <Text dimColor>{t('plugins-panel-unavailable-body-1')}</Text>
          <Text dimColor>{t('plugins-panel-unavailable-body-2')}</Text>
          <Text dimColor>{t('plugins-panel-unavailable-body-3')}</Text>
        </>
      )}
      {onDiagnostics !== undefined && (
        <>
          <Box height={1} />
          <Box
            flexDirection="row"
            onClick={(event: ClickEvent) => {
              event.stopImmediatePropagation()
              onDiagnostics()
            }}
          >
            <Text color={focused ? 'suggestion' : undefined} dimColor={!focused}>d</Text>
            <Text dimColor={!focused}>{`  ${t('plugins-panel-unavailable-action')}`}</Text>
          </Box>
        </>
      )}
    </Box>
  )
}

/** 行内详情展开：package name、rows/overrides、error/readOnly 信息。 */
function BundleDetail({ bundle, width }: {
  bundle: PluginPanelBundle
  width: number
}): React.ReactNode {
  const detailWidth = Math.max(8, width - 4)
  return (
    <Box flexDirection="column" paddingLeft={4} width="100%">
      {/* package name（title 可能是本地化名称，name 是 npm 包名） */}
      <Box height={1} flexShrink={0} overflow="hidden" width={detailWidth}>
        <Text dimColor wrap="truncate-end">{bundle.name}</Text>
      </Box>
      {/* rows / overrides 计数 */}
      <Box height={1} flexShrink={0} overflow="hidden" width={detailWidth}>
        <Text dimColor wrap="truncate-end">
          {t('plugins-panel-detail-rows', { rows: String(bundle.rows), overrides: String(bundle.overrides) })}
        </Text>
      </Box>
      {/* error */}
      {bundle.error !== undefined && (
        <Box height={1} flexShrink={0} overflow="hidden" width={detailWidth}>
          <Text color="error" wrap="truncate-end">
            {t('plugins-panel-detail-error', { code: bundle.error.code })}
          </Text>
        </Box>
      )}
      {/* readOnlyReason */}
      {bundle.readOnlyReason !== undefined && (
        <Box height={1} flexShrink={0} overflow="hidden" width={detailWidth}>
          <Text color="warning" wrap="truncate-end">
            {t('plugins-panel-detail-readonly', { reason: bundle.readOnlyReason })}
          </Text>
        </Box>
      )}
      {/* removable 状态 */}
      {!bundle.removable && bundle.group !== 'base' && (
        <Box height={1} flexShrink={0} overflow="hidden" width={detailWidth}>
          <Text dimColor wrap="truncate-end">{t('plugins-panel-detail-kept')}</Text>
        </Box>
      )}
    </Box>
  )
}

/** 计算节点在 ScrollBox 内容中的顶部行号（沿祖先累加 Yoga top，直到 ScrollBox）。 */
function contentRowOf(node: DOMElement): number | undefined {
  let rows = 0
  let current: DOMElement | undefined = node
  while (current !== undefined && current.parentNode !== undefined) {
    if (current.parentNode.scrollTop !== undefined) return rows + (current.yogaNode?.getComputedTop() ?? 0)
    rows += current.yogaNode?.getComputedTop() ?? 0
    current = current.parentNode
  }
  return undefined
}

type FlatItem =
  | { readonly kind: 'base-toggle'; readonly key: 'base-toggle' }
  | { readonly kind: 'bundle'; readonly key: string; readonly bundle: PluginPanelBundle }

export function PluginsPanel({ width, height, focused, visible }: PanelProps): React.ReactNode {
  const channel = useSidePanelChannel()
  const focusPanel = useSidePanelFocusPanel()
  const { managePlugin, installPlugin, pluginWriteRevision, showPluginDiagnostics } = useSidePanelPluginActions()
  const pluginServiceAvailable = pluginPanelServiceAvailable(channel)
  const currentLang = getLang()
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const rowNodes = React.useRef(new Map<string, DOMElement>())
  const registerRow = React.useCallback((key: string, node: DOMElement | null) => {
    if (node === null) rowNodes.current.delete(key)
    else rowNodes.current.set(key, node)
  }, [])
  const pendingContextBundleRef = React.useRef<string | null>(null)

  const [bundles, setBundles] = React.useState<readonly PluginPanelBundle[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [focusedKey, setFocusedKey] = React.useState<string | null>(null)
  const [baseCollapsed, setBaseCollapsed] = React.useState(true)
  /** Name of the bundle whose detail view is expanded; null = all collapsed. */
  const [expandedBundle, setExpandedBundle] = React.useState<string | null>(null)
  const [menu, setMenu] = React.useState<PluginContextMenuState | null>(null)

  const mountedRef = React.useRef(true)
  React.useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const fetchNonceRef = React.useRef(0)
  const refresh = React.useCallback((options: { readonly background?: boolean } = {}) => {
    if (!pluginServiceAvailable) return
    const nonce = fetchNonceRef.current + 1
    fetchNonceRef.current = nonce
    if (options.background !== true) setLoading(true)
    // A partial channel can still expose `pluginPanelAvailable` without the
    // data method; resolve through a promise so its synchronous TypeError
    // lands in the error state instead of escaping the effect to
    // PanelErrorBoundary.
    void Promise.resolve()
      .then(() => channel.pluginPanelBundles())
      .then(result => {
        if (!mountedRef.current || nonce !== fetchNonceRef.current) return
        setBundles(result)
        // The error view stays up until a request actually succeeds: a background
        // retry must not expose the pre-error list while its answer is in flight
        // (those rows may already be gone from the profile).
        setError(null)
        setLoading(false)
      }, (err: unknown) => {
        if (!mountedRef.current || nonce !== fetchNonceRef.current) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
  }, [channel, pluginServiceAvailable])

  // 初次挂载拉取数据；服务未挂载时不发请求
  React.useEffect(() => {
    if (!pluginServiceAvailable) return
    refresh({ background: false })
  }, [refresh, pluginServiceAvailable])

  // 宿主 plugin-manager/changed 时后台静默刷新，保持当前列表与滚动
  React.useEffect(() => {
    if (!pluginServiceAvailable) return undefined
    const subscribe = channel.subscribePluginBundles as ((listener: () => void) => () => void) | undefined
    if (typeof subscribe !== 'function') return undefined
    return subscribe(() => refresh({ background: true }))
  }, [channel, channel.agentBindingGeneration, refresh, pluginServiceAvailable])

  // Chat 侧插件写操作结算、会话切换或语言切换时同步刷新
  const writeRevRef = React.useRef(pluginWriteRevision)
  React.useEffect(() => {
    if (!pluginServiceAvailable) return
    if (pluginWriteRevision !== writeRevRef.current) {
      writeRevRef.current = pluginWriteRevision
      refresh({ background: true })
    }
  }, [pluginWriteRevision, refresh, pluginServiceAvailable])

  const bindingRef = React.useRef({ gen: channel.agentBindingGeneration, lang: currentLang })
  React.useEffect(() => {
    if (!pluginServiceAvailable) return
    if (channel.agentBindingGeneration !== bindingRef.current.gen || currentLang !== bindingRef.current.lang) {
      bindingRef.current = { gen: channel.agentBindingGeneration, lang: currentLang }
      refresh({ background: true })
    }
  }, [channel.agentBindingGeneration, currentLang, refresh, pluginServiceAvailable])

  const extra = React.useMemo(() => bundles.filter(b => b.group === 'extra'), [bundles])
  const experimental = React.useMemo(() => bundles.filter(b => b.group === 'experimental'), [bundles])
  const base = React.useMemo(() => bundles.filter(b => b.group === 'base'), [bundles])

  // 展平可聚焦项（Divider 仅作视觉分隔，不参与焦点序列）
  const flatItems = React.useMemo<readonly FlatItem[]>(() => {
    const items: FlatItem[] = []
    for (const bundle of extra) items.push({ kind: 'bundle', key: `bundle:${bundle.name}`, bundle })
    for (const bundle of experimental) items.push({ kind: 'bundle', key: `bundle:${bundle.name}`, bundle })
    if (base.length > 0) {
      items.push({ kind: 'base-toggle', key: 'base-toggle' })
      if (!baseCollapsed) {
        for (const bundle of base) items.push({ kind: 'bundle', key: `bundle:${bundle.name}`, bundle })
      }
    }
    return items
  }, [extra, experimental, base, baseCollapsed])

  const indexByKey = React.useMemo(() => {
    const map = new Map<string, number>()
    flatItems.forEach((item, index) => map.set(item.key, index))
    return map
  }, [flatItems])

  const lastIndexRef = React.useRef(0)
  const rawFocusIndex = focusedKey === null ? -1 : (indexByKey.get(focusedKey) ?? -1)
  const focusIndex = flatItems.length === 0
    ? 0
    : rawFocusIndex >= 0
      ? rawFocusIndex
      : Math.min(lastIndexRef.current, flatItems.length - 1)
  const focusedItem = flatItems[focusIndex] as FlatItem | undefined

  React.useEffect(() => {
    lastIndexRef.current = focusIndex
    if (focusedItem !== undefined && focusedItem.key !== focusedKey) {
      setFocusedKey(focusedItem.key)
    } else if (flatItems.length === 0 && focusedKey !== null) {
      setFocusedKey(null)
    }
  }, [focusIndex, focusedItem, focusedKey, flatItems.length])

  // 若展开的详情已从当前可见列表消失（如卸载或折叠 base），清理 stale 状态，防止多吞一次 Esc
  const expandedVisible = expandedBundle !== null
    && flatItems.some(item => item.kind === 'bundle' && item.bundle.name === expandedBundle)
  React.useEffect(() => {
    if (expandedBundle !== null && !expandedVisible) setExpandedBundle(null)
  }, [expandedBundle, expandedVisible])

  // 右键菜单对应的 bundle 与动作列表；面板失焦、隐藏、加载/错误态、目标移除或可执行动作变化时收起菜单
  const menuBundle = menu === null ? undefined : bundles.find(b => b.name === menu.bundleName)
  const menuActions = React.useMemo<readonly PluginMenuAction[]>(
    () => menuBundle === undefined ? [] : menuActionsFor(menuBundle, managePlugin !== undefined),
    [menuBundle, managePlugin],
  )
  const menuActionsKey = menuActions.join(',')
  const menuOpen = menu !== null && menuBundle !== undefined && menuActions.length > 0 && menu.actionsKey === menuActionsKey
  React.useEffect(() => {
    if (menu !== null && (!focused || !visible || loading || error !== null || !menuOpen)) {
      setMenu(null)
    }
  }, [menu, focused, visible, loading, error, menuOpen])

  const executeMenuAction = React.useCallback((bundle: PluginPanelBundle, action: PluginMenuAction) => {
    setMenu(null)
    managePlugin?.(action, bundle.name)
  }, [managePlugin])

  // 焦点/详情变化或错误视图恢复列表时，重新把焦点项及其详情滚入视口。
  const activeItemKey = focusedItem?.key
  const visibleExpanded = expandedVisible ? expandedBundle : null
  React.useLayoutEffect(() => {
    if (loading || error !== null || activeItemKey === undefined) return
    const handle = scrollRef.current
    const node = rowNodes.current.get(activeItemKey)
    if (handle === null || node === undefined) return
    // 首帧还未写入 viewport 缓存；此处 ScrollBox 独占固定高度的面板内容区。
    const viewport = handle.getViewportHeight() || Math.max(1, height)
    const top = contentRowOf(node)
    if (top === undefined) return
    const rows = Math.max(1, Math.ceil(node.yogaNode?.getComputedHeight() ?? 1))
    const scrollTop = handle.getScrollTop()
    if (focusIndex === 0 && scrollTop > 0 && top <= 2) {
      handle.scrollTo(0)
    } else if (top < scrollTop) {
      handle.scrollTo(top)
    } else if (top + rows > scrollTop + viewport) {
      handle.scrollTo(rows >= viewport ? top : top + rows - viewport)
    }
  }, [activeItemKey, focusIndex, visibleExpanded, baseCollapsed, height, loading, error])

  // hint 广告（渲染期求值以跟随语言切换；卸载或缩窄时清理）
  const hintText = !visible
    ? ''
    : !pluginServiceAvailable
      ? (showPluginDiagnostics !== undefined ? t('plugins-panel-hint-unavailable') : '')
      : loading || error !== null
        ? ''
        : menuOpen
          ? t('plugins-panel-hint-menu')
          : focusedItem === undefined
            ? (installPlugin !== undefined ? t('plugins-panel-hint-empty') : '')
            : focusedItem.kind === 'base-toggle'
              ? t('plugins-panel-hint-group')
              : menuActionsFor(focusedItem.bundle, managePlugin !== undefined).length > 0
                ? t('plugins-panel-hint-bundle')
                : ''
  React.useEffect(() => {
    panelStore.setHint('plugins', hintText)
    return () => { panelStore.setHint('plugins', '') }
  }, [hintText])

  // 键盘处理（注意：Ink 孤立 Esc 带 { escape: true, meta: true }，必须先判 escape 再让出 meta）
  usePanelInput((input, key) => {
    if (!pluginServiceAvailable) {
      if ((input === 'd' || input === 'D') && showPluginDiagnostics !== undefined) {
        showPluginDiagnostics()
        return true
      }
      return false
    }
    if (loading || error !== null) return false
    if (key.escape === true) {
      if (menuOpen) {
        setMenu(null)
        return true
      }
      if (expandedVisible) {
        setExpandedBundle(null)
        return true
      }
      return false
    }
    if (key.ctrl === true || key.meta === true || key.super === true) return false

    // 右键菜单打开时由菜单接管方向键与确认键
    if (menuOpen && menu !== null && menuBundle !== undefined) {
      if (key.upArrow === true) {
        setMenu(cur => cur === null ? null : { ...cur, item: (cur.item - 1 + menuActions.length) % menuActions.length })
        return true
      }
      if (key.downArrow === true) {
        setMenu(cur => cur === null ? null : { ...cur, item: (cur.item + 1) % menuActions.length })
        return true
      }
      if (key.return_ === true || input === ' ') {
        const action = menuActions[menu.item]
        if (action !== undefined) executeMenuAction(menuBundle, action)
        return true
      }
      return true
    }

    const moveFocus = (delta: number): void => {
      setFocusedKey(prevKey => {
        if (flatItems.length === 0) return null
        const curIdx = prevKey === null ? -1 : (indexByKey.get(prevKey) ?? -1)
        const baseIdx = curIdx >= 0 ? curIdx : Math.min(lastIndexRef.current, flatItems.length - 1)
        const nextIdx = Math.max(0, Math.min(flatItems.length - 1, baseIdx + delta))
        return flatItems[nextIdx]?.key ?? null
      })
    }
    if (key.upArrow === true) {
      if (flatItems.length === 0) return false
      moveFocus(-1)
      return true
    }
    if (key.downArrow === true) {
      if (flatItems.length === 0) return false
      moveFocus(1)
      return true
    }
    // `m` opens the same context menu without a mouse; rows without an action
    // keep Enter/Space as the only binding.
    if ((input === 'm' || input === 'M') && focusedItem?.kind === 'bundle') {
      const actions = menuActionsFor(focusedItem.bundle, managePlugin !== undefined)
      if (actions.length === 0) return false
      const node = rowNodes.current.get(focusedItem.key)
      const top = node === undefined ? 0 : contentRowOf(node) ?? 0
      const rows = Math.max(1, Math.ceil(node?.yogaNode?.getComputedHeight() ?? 1))
      const scrollTop = scrollRef.current?.getScrollTop() ?? 0
      setMenu({
        bundleName: focusedItem.bundle.name,
        localCol: 0,
        // The menu box itself draws at localRow + 1, so this lands just below
        // the focused row (and below an expanded detail).
        localRow: Math.max(0, top - scrollTop + rows - 1),
        item: 0,
        actionsKey: actions.join(','),
      })
      return true
    }
    if (key.return_ === true || input === ' ') {
      if (focusedItem?.kind === 'base-toggle') {
        setBaseCollapsed(c => !c)
        return true
      }
      if (focusedItem?.kind === 'bundle') {
        const name = focusedItem.bundle.name
        setExpandedBundle(prev => prev === name ? null : name)
        return true
      }
      return false
    }
    // i = install prompt（空列表与面板内快捷触发）
    if (input === 'i' && installPlugin !== undefined) {
      installPlugin()
      return true
    }
    return false
  }, { active: focused && visible })

  const contentWidth = Math.max(10, width - 2)

  if (!pluginServiceAvailable) {
    return (
      <ServiceUnavailable
        width={width}
        height={height}
        focused={focused}
        onDiagnostics={showPluginDiagnostics}
      />
    )
  }

  if (loading) {
    return (
      <Box flexDirection="column" paddingLeft={1} paddingRight={1} width={width} height={height} overflow="hidden">
        <Box marginTop={1}>
          <LoadingState message={t('plugins-panel-loading')} />
        </Box>
      </Box>
    )
  }

  if (error !== null) {
    return (
      <Box flexDirection="column" paddingLeft={1} paddingRight={1} width={width} height={height} overflow="hidden">
        <Box marginTop={1}>
          <Text color="error">{t('plugins-panel-error', { reason: error })}</Text>
        </Box>
      </Box>
    )
  }

  if (flatItems.length === 0) {
    return (
      <Box flexDirection="column" paddingLeft={1} paddingRight={1} width={width} height={height} overflow="hidden">
        <EmptyHint message={t('plugins-panel-empty')} />
      </Box>
    )
  }

  const renderBundle = (bundle: PluginPanelBundle): React.ReactNode => {
    const key = `bundle:${bundle.name}`
    const itemIndex = indexByKey.get(key)
    const isFocused = itemIndex === focusIndex
    return (
      <Box
        key={key}
        ref={node => registerRow(key, node)}
        flexDirection="column"
        width="100%"
        flexShrink={0}
        onClick={(event: ClickEvent) => {
          event.stopImmediatePropagation()
          focusPanel?.()
          if (menu !== null) {
            setMenu(null)
            setFocusedKey(key)
            setExpandedBundle(bundle.name)
            return
          }
          if (focusedKey === key) {
            setExpandedBundle(prev => prev === bundle.name ? null : bundle.name)
          } else {
            setFocusedKey(key)
            setExpandedBundle(bundle.name)
          }
        }}
        onContextMenu={() => {
          pendingContextBundleRef.current = bundle.name
        }}
      >
        <BundleRow
          bundle={bundle}
          focused={isFocused}
          width={contentWidth}
        />
        {visibleExpanded === bundle.name && (
          <BundleDetail bundle={bundle} width={contentWidth} />
        )}
      </Box>
    )
  }

  const baseToggleFocused = indexByKey.get('base-toggle') === focusIndex
  const menuWidth = Math.min(20, Math.max(12, width - 2))
  const menuHeight = menuActions.length + 2
  const menuLeft = menu === null ? 0 : Math.max(0, Math.min(menu.localCol + 1, Math.max(0, width - menuWidth)))
  const menuTop = menu === null ? 0 : Math.max(0, Math.min(menu.localRow + 1, Math.max(0, height - menuHeight)))

  return (
    <Box
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      width={width}
      height={height}
      overflow="hidden"
      flexShrink={0}
      onClick={() => {
        if (menu !== null) setMenu(null)
      }}
      onContextMenu={(event: ContextMenuEvent) => {
        event.stopImmediatePropagation()
        const bundleName = pendingContextBundleRef.current
        pendingContextBundleRef.current = null
        if (bundleName === null) {
          setMenu(null)
          return
        }
        const target = bundles.find(b => b.name === bundleName)
        if (target === undefined) {
          setMenu(null)
          return
        }
        setFocusedKey(`bundle:${bundleName}`)
        focusPanel?.()
        const actions = menuActionsFor(target, managePlugin !== undefined)
        if (actions.length === 0) {
          setMenu(null)
          return
        }
        setMenu({
          bundleName,
          localCol: event.localCol,
          localRow: event.localRow,
          item: 0,
          actionsKey: actions.join(','),
        })
      }}
    >
      <ScrollBox ref={scrollRef} flexDirection="column" maxHeight={Math.max(1, height)} flexGrow={1} followBottom={false}>
        {extra.length > 0 && (
          <Box flexDirection="column" width="100%" flexShrink={0}>
            <Divider title={` ${t('plugins-panel-group-extra')} `} />
            {extra.map(renderBundle)}
          </Box>
        )}
        {experimental.length > 0 && (
          <Box flexDirection="column" marginTop={extra.length > 0 ? 1 : 0} width="100%" flexShrink={0}>
            <Divider title={` ${t('plugins-panel-group-experimental')} `} />
            {experimental.map(renderBundle)}
          </Box>
        )}
        {base.length > 0 && (
          <Box flexDirection="column" marginTop={extra.length > 0 || experimental.length > 0 ? 1 : 0} width="100%" flexShrink={0}>
            <Divider title={` ${t('plugins-panel-group-base')} `} />
            <Box
              ref={node => registerRow('base-toggle', node)}
              flexDirection="column"
              width="100%"
              flexShrink={0}
              onClick={(event: ClickEvent) => {
                event.stopImmediatePropagation()
                focusPanel?.()
                if (menu !== null) setMenu(null)
                setFocusedKey('base-toggle')
                setBaseCollapsed(c => !c)
              }}
            >
              <GroupHeader
                title={t('plugins-panel-group-base')}
                count={base.length}
                collapsed={baseCollapsed}
                focused={baseToggleFocused}
              />
            </Box>
            {!baseCollapsed && base.map(renderBundle)}
          </Box>
        )}
      </ScrollBox>

      {menuOpen && menu !== null && menuBundle !== undefined && (
        <Box
          position="absolute"
          left={menuLeft}
          top={menuTop}
          width={menuWidth}
          height={menuHeight}
          flexDirection="column"
          flexShrink={0}
          borderStyle="round"
          borderColor="permission"
          backgroundColor="toolCardBackground"
          opaque
        >
          {menuActions.map((action, index) => {
            const label = t(menuLabelKey(action))
            return (
              <Box
                key={action}
                height={1}
                flexShrink={0}
                backgroundColor={index === menu.item ? 'userMessageBackgroundHover' : undefined}
                onMouseEnter={(): void => setMenu(cur => cur === null ? null : { ...cur, item: index })}
                onClick={(event: ClickEvent): void => {
                  event.stopImmediatePropagation()
                  executeMenuAction(menuBundle, action)
                }}
              >
                <Text color={action === 'remove' ? 'error' : undefined}>
                  {truncateWidth(` ${index === menu.item ? '❯' : ' '} ${label}`, Math.max(4, menuWidth - 2))}
                </Text>
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )
}
