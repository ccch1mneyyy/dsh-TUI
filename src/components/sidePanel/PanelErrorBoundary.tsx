/**
 * PanelErrorBoundary（照 PluginStatusViewBoundary 的约定）：出错只隐藏
 * 该 Panel、记 reportError，同 key 重注册用 registrationId 重挂。插件
 * Panel 崩溃时，Chat 的输入、流式、工具卡必须完全不受影响——硬要求。
 */
import React from 'react'
import { Box, Text } from '../../ui.js'
import { t } from '../../i18n.js'
import { logError } from '../../utils/log.js'
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
    // 卡片上只显示截断的 message，卸载即失忆——落盘一份带边界的完整
    // 错误（含堆栈），否则"面板渲染出错"永远无法事后归因。
    logError(new Error(`side panel "${this.props.panelId}" render error: ${error.message}`, { cause: error }))
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
