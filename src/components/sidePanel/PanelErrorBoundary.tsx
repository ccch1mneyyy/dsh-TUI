/**
 * PanelErrorBoundary（照 PluginStatusViewBoundary 的约定）：出错只隐藏
 * 该 Panel、记 reportError，同 key 重注册用 registrationId 重挂。插件
 * Panel 崩溃时，Chat 的输入、流式、工具卡必须完全不受影响——硬要求。
 */
import React from 'react'
import { Box, Text } from '../../ui.js'
import { t } from '../../i18n.js'
import { panelStore } from './PanelStore.js'

interface BoundaryProps {
  readonly panelId: string
  readonly children: React.ReactNode
}

interface BoundaryState {
  readonly error: Error | null
}

export class PanelErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error): void {
    panelStore.reportError(this.props.panelId, error)
  }

  override render(): React.ReactNode {
    const { error } = this.state
    if (error !== null) {
      return (
        <Box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center" paddingX={1}>
          <Text color="error">{t('panel-error-title')}</Text>
          <Box height={1} />
          <Text dimColor wrap="truncate-end">{error.message}</Text>
          <Box height={1} />
          <Text dimColor>{t('panel-error-hint')}</Text>
        </Box>
      )
    }
    return this.props.children
  }
}
