/**
 * PluginsPanel — 侧栏「插件」面板：分组列出 profile 的 bundle，支持
 * 键盘导航与操作入口（enable/disable/remove/install）。
 *
 * 数据来源：channel.pluginPanelBundles()（异步，面板挂载时拉取、操作后刷新）。
 * 操作复用 Chat.tsx 的现有浮层流程（startPluginManage / startPluginInstall），
 * 面板自身只负责列表浏览与操作入口。
 *
 * 分组（Divider 分隔）：
 * - 已安装（extra）：用户手动安装的第三方 bundle
 * - 实验功能（experimental）：安装提供的可选实验 bundle
 * - 基础组件（base）：composition 自带，默认折叠
 */
import React from 'react'
import { Box, Text, ScrollBox, type ScrollBoxHandle } from '../../../ui.js'
import { t } from '../../../i18n.js'
import { Divider } from '../../design-system/Divider.js'
import { useSidePanelChannel } from '../SidePanelRuntimeContext.js'
import { usePanelInput } from '../usePanelInput.js'
import { panelStore } from '../PanelStore.js'
import { LoadingState } from '../../design-system/LoadingState.js'
import type { PanelProps } from '../types.js'
import type { PluginPanelBundle } from '../../../adapter/ports/channel-ui.js'

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
  // 标题列 = 总宽 - pointer(2) - 状态列(2) - 版本列(如有,9) - gap
  const versionWidth = showVersion ? 9 : 0
  const titleWidth = Math.max(6, width - 4 - versionWidth - (showVersion ? 1 : 0))
  return (
    <Box flexDirection="row" height={1} flexShrink={0} width="100%">
      <Box width={2} flexShrink={0}>
        <Text color={focused ? 'suggestion' : undefined}>{focused ? '❯' : ' '}</Text>
      </Box>
      <Box width={titleWidth} flexShrink={0} overflow="hidden">
        <Text color={focused ? 'suggestion' : undefined} wrap="truncate-end">
          {bundle.title}
        </Text>
      </Box>
      {showVersion && (
        <Box width={versionWidth} flexShrink={0} justifyContent="flex-end" overflow="hidden">
          <Text dimColor wrap="truncate-end">{bundle.version ?? ''}</Text>
        </Box>
      )}
      <Box width={2} flexShrink={0} justifyContent="flex-end">
        <Text color={statusColor} dimColor={statusColor === undefined}>{statusIcon}</Text>
      </Box>
    </Box>
  )
}

/** 折叠分组头。 */
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
      <Text dimColor>{icon} {title} ({count})</Text>
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

type FlatItem =
  | { readonly kind: 'group-header'; readonly group: PluginPanelBundle['group']; readonly title: string; readonly count: number }
  | { readonly kind: 'bundle'; readonly bundle: PluginPanelBundle }

export function PluginsPanel({ width, height, focused, visible }: PanelProps): React.ReactNode {
  const channel = useSidePanelChannel()
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const [bundles, setBundles] = React.useState<readonly PluginPanelBundle[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [focusIndex, setFocusIndex] = React.useState(0)
  const [baseCollapsed, setBaseCollapsed] = React.useState(true)

  // 拉取数据
  const refresh = React.useCallback(() => {
    setLoading(true)
    setError(null)
    channel.pluginPanelBundles().then(result => {
      setBundles(result)
      setLoading(false)
    }, (err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
      setLoading(false)
    })
  }, [channel])

  // 挂载时拉取；channel version 变化时刷新（profile 重载后 bundle 状态可能变了）
  const versionRef = React.useRef(channel.version)
  React.useEffect(() => {
    refresh()
  }, [refresh])
  React.useEffect(() => {
    if (channel.version !== versionRef.current) {
      versionRef.current = channel.version
      refresh()
    }
  }, [channel.version, refresh])

  // 展平列表
  const flatItems = React.useMemo<readonly FlatItem[]>(() => {
    const extra = bundles.filter(b => b.group === 'extra')
    const experimental = bundles.filter(b => b.group === 'experimental')
    const base = bundles.filter(b => b.group === 'base')
    const items: FlatItem[] = []
    if (extra.length > 0) {
      items.push({ kind: 'group-header', group: 'extra', title: t('plugins-panel-group-extra'), count: extra.length })
      for (const bundle of extra) items.push({ kind: 'bundle', bundle })
    }
    if (experimental.length > 0) {
      items.push({ kind: 'group-header', group: 'experimental', title: t('plugins-panel-group-experimental'), count: experimental.length })
      for (const bundle of experimental) items.push({ kind: 'bundle', bundle })
    }
    if (base.length > 0) {
      items.push({ kind: 'group-header', group: 'base', title: t('plugins-panel-group-base'), count: base.length })
      if (!baseCollapsed) {
        for (const bundle of base) items.push({ kind: 'bundle', bundle })
      }
    }
    return items
  }, [bundles, baseCollapsed])

  // 焦点越界修正
  React.useEffect(() => {
    if (flatItems.length === 0) return
    if (focusIndex >= flatItems.length) setFocusIndex(flatItems.length - 1)
  }, [flatItems.length, focusIndex])

  const focusedItem = flatItems[focusIndex] as FlatItem | undefined

  // hint 广告
  React.useEffect(() => {
    if (!visible) return
    if (focusedItem === undefined) {
      panelStore.setHint('plugins', t('plugins-panel-hint-empty'))
      return
    }
    if (focusedItem.kind === 'group-header') {
      panelStore.setHint('plugins', t('plugins-panel-hint-group'))
      return
    }
    const b = focusedItem.bundle
    if (b.group === 'base') {
      panelStore.setHint('plugins', '')
      return
    }
    panelStore.setHint('plugins', t('plugins-panel-hint-bundle'))
  }, [visible, focusedItem])

  // 键盘处理
  usePanelInput((input, key) => {
    if (key.ctrl || key.meta) return false
    if (key.escape) return false
    if (key.upArrow) {
      setFocusIndex(i => Math.max(0, i - 1))
      scrollRef.current?.scrollBy(-1)
      return true
    }
    if (key.downArrow) {
      setFocusIndex(i => Math.min(flatItems.length - 1, i + 1))
      scrollRef.current?.scrollBy(1)
      return true
    }
    if (key.return_ || input === ' ') {
      if (focusedItem?.kind === 'group-header' && focusedItem.group === 'base') {
        setBaseCollapsed(c => !c)
        return true
      }
      if (focusedItem?.kind === 'bundle') {
        // Enter on a bundle toggles enable/disable
        const b = focusedItem.bundle
        if (b.group !== 'base' && b.readOnlyReason === undefined) {
          const sub = b.enabled ? 'disable' : 'enable'
          channel.pluginsInfo(`${sub} ${b.name}`)
          return true
        }
      }
      return true
    }
    // e = enable, d = disable
    if ((input === 'e' || input === 'd') && focusedItem?.kind === 'bundle') {
      const b = focusedItem.bundle
      if (b.group !== 'base' && b.readOnlyReason === undefined) {
        const sub = input === 'e' ? 'enable' : 'disable'
        channel.pluginsInfo(`${sub} ${b.name}`)
        return true
      }
    }
    // r = remove
    if (input === 'r' && focusedItem?.kind === 'bundle') {
      const b = focusedItem.bundle
      if (b.removable) {
        channel.pluginsInfo(`remove ${b.name}`)
        return true
      }
    }
    return false
  }, { active: focused && visible })

  const contentWidth = Math.max(10, width - 2)

  if (loading) {
    return (
      <Box flexDirection="column" paddingLeft={1} paddingRight={1} width={width}>
        <Box marginTop={1}>
          <LoadingState message={t('plugins-panel-loading')} />
        </Box>
      </Box>
    )
  }

  if (error !== null) {
    return (
      <Box flexDirection="column" paddingLeft={1} paddingRight={1} width={width}>
        <Box marginTop={1}>
          <Text color="error">{t('plugins-panel-error', { reason: error })}</Text>
        </Box>
      </Box>
    )
  }

  if (flatItems.length === 0) {
    return (
      <Box flexDirection="column" paddingLeft={1} paddingRight={1} width={width}>
        <EmptyHint message={t('plugins-panel-empty')} />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1} width={width} flexShrink={0}>
      <ScrollBox ref={scrollRef} flexDirection="column" maxHeight={Math.max(3, height)} flexGrow={1}>
        {flatItems.map((item, index) => {
          if (item.kind === 'group-header') {
            return (
              <Box key={`gh-${item.group}`} flexDirection="column" marginTop={index > 0 ? 1 : 0} width="100%">
                <Divider title={` ${item.title} `} />
                {item.group === 'base' && (
                  <GroupHeader
                    title={item.title}
                    count={item.count}
                    collapsed={baseCollapsed}
                    focused={index === focusIndex}
                  />
                )}
              </Box>
            )
          }
          return (
            <BundleRow
              key={item.bundle.name}
              bundle={item.bundle}
              focused={index === focusIndex}
              width={contentWidth}
            />
          )
        })}
      </ScrollBox>
    </Box>
  )
}
