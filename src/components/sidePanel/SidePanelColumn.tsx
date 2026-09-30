/**
 * SidePanelColumn: the right surface's chrome — PanelBar on top, PanelHost
 * in the middle, and a 1-row key hint at the bottom (design doc §6.1).
 *
 * The hint row swaps text with focus: unfocused it advertises Ctrl+B,
 * focused it lists the panel keys. The two thin rules frame the host and
 * brighten to 'accent' together with the divider when the column has the
 * focus — the whole seam lights up as one surface.
 *
 * Tabs come from the PanelStore (enabled ∩ registered, badge included);
 * builtin registrations arrive via registerBuiltinPanels on module import.
 */
import React from 'react'
import { Box, Text, useTerminalSize } from '../../ui.js'
import { t } from '../../i18n.js'
import type { ChannelUi } from '../../adapter/channel/ui-policy.js'
import { useSurfaceEdges } from '../SurfaceEdges.js'
import { PanelBar, type PanelBarTab } from './PanelBar.js'
import { PanelHost } from './PanelHost.js'
import { panelStore } from './PanelStore.js'
import { registerBuiltinPanels } from './builtinPanels.js'
import type { SidePanelController } from './useSidePanel.js'

registerBuiltinPanels()

export interface SidePanelColumnProps {
  readonly width: number
  readonly controller: SidePanelController
  readonly channel: ChannelUi
  readonly activity?: import('../../dsh-adapter/activity-store.js').ActivityView
  readonly attention?: { readonly approvals: number; readonly questions: number }
}

function fallbackTitle(id: string): string {
  const bare = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id
  return bare.charAt(0).toUpperCase() + bare.slice(1)
}

function Rule({ focused }: { readonly focused: boolean }): React.ReactNode {
  // Structural chrome bleeds: the rule runs past the content column to the
  // terminal's right edge (the panel surface's SurfaceEdges allow right
  // bleed; zero without a page margin, so this is a no-op there).
  const edges = useSurfaceEdges()
  return (
    <Box
      height={1}
      flexShrink={0}
      marginRight={-edges.right}
      borderStyle="single"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderColor={focused ? 'accent' : 'inactive'}
    />
  )
}

/** 没有「已启用 ∩ 已注册」面板时的空态。 */
function EmptyNone(): React.ReactNode {
  return (
    <Box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center" paddingX={1}>
      <Text dimColor wrap="truncate-end">{t('panel-empty-none')}</Text>
    </Box>
  )
}

export function SidePanelColumn({ width, controller, channel, activity, attention }: SidePanelColumnProps): React.ReactNode {
  const focused = controller.focus === 'panel'
  const { rows } = useTerminalSize()
  const entries = React.useSyncExternalStore(panelStore.subscribe, () => panelStore.list())
  const tabs: PanelBarTab[] = controller.enabledPanelIds.map(id => {
    const entry = entries.find(candidate => candidate.definition.id === id)
    if (entry === undefined) return { id, title: fallbackTitle(id) }
    const def = entry.definition
    return {
      id,
      title: def.titleKey !== undefined ? t(def.titleKey) : def.title ?? fallbackTitle(id),
      icon: def.icon,
      badge: entry.badge,
    }
  })
  const anyRegistered = tabs.length > 0 && entries.length > 0 &&
    controller.enabledPanelIds.some(id => entries.some(entry => entry.definition.id === id))
  // Host 高度 = 列高 - PanelBar/上规/下规/hint 四行 chrome。
  const hostHeight = Math.max(1, rows - 4)
  return (
    <Box flexDirection="column" width={width} flexGrow={1}>
      <PanelBar tabs={tabs} activeId={controller.activePanelId} width={width - 2} focused={focused} />
      <Rule focused={focused} />
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {anyRegistered
          ? <PanelHost controller={controller} channel={channel} width={width} height={hostHeight} activity={activity} attention={attention} />
          : <EmptyNone />}
      </Box>
      <Rule focused={focused} />
      <Box height={1} flexShrink={0} paddingX={1} overflow="hidden">
        <Text dimColor wrap="truncate-end">
          {focused ? t('panel-hint-focused') : t('panel-hint-unfocused')}
        </Text>
      </Box>
    </Box>
  )
}
