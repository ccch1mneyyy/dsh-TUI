/**
 * PanelErrorBoundary（照 PluginStatusViewBoundary 的约定）：出错只隐藏
 * 该 Panel、记 reportError，同 key 重注册用 registrationId 重挂。插件
 * Panel 崩溃时，Chat 的输入、流式、工具卡必须完全不受影响——硬要求。
 */
import React from 'react'
import { Box, Text } from '../../ui.js'
import { t } from '../../i18n.js'
import { logError } from '../../utils/log.js'
import { thrownText } from '../../utils/thrownText.js'
import { cleanRenderText, headUnits } from '../../channel/sanitize.js'
import { panelStore } from './PanelStore.js'

/** 错误消息读源上限（UTF-16 码元）：远超它能显示的 200 格，插件抛出几 MB
 *  的 message 也只花有界的清洗，不会在 Chat 里卡住输入。 */
const MESSAGE_UNITS = 1024
const MESSAGE_CELLS = 200

/** 抛出值的消息：先截源再清洗。插件可以抛任何东西——几 MB 的 message、
 *  带终端控制序列的、getter 会抛的——日志、store 与两种变体都只用这一份，
 *  绝不在边界里再抛。 */
function panelErrorMessage(error: unknown): string {
  return cleanRenderText(headUnits(thrownText(error), MESSAGE_UNITS), MESSAGE_CELLS)
}

interface BoundaryProps {
  readonly panelId: string
  /** `row`：compact 行用的单行错误条（卡片在 1–3 行的槽里放不下）。 */
  readonly variant?: 'card' | 'row'
  readonly children: React.ReactNode
}

interface BoundaryState {
  /** 崩溃后显示的消息（{@link panelErrorMessage}）；没崩溃时 null。 */
  readonly message: string | null
}

export class PanelErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { message: null }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { message: panelErrorMessage(error) }
  }

  override componentDidCatch(error: unknown): void {
    // 卡片上只显示截断的 message，卸载即失忆——落盘一份带边界的错误（消息
    // 已截断清洗，原错误挂在 cause 上），否则"面板渲染出错"永远无法事后归因。
    const message = panelErrorMessage(error)
    logError(new Error(`side panel "${this.props.panelId}" render error: ${message}`, { cause: error }))
    panelStore.reportError(this.props.panelId, message)
  }

  override render(): React.ReactNode {
    const { message } = this.state
    if (message !== null && this.props.variant === 'row') {
      return (
        <Text color="error" wrap="truncate-end">{t('panel-error-title')} · {message}</Text>
      )
    }
    if (message !== null) {
      return (
        <Box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center" paddingX={1}>
          <Text color="error">{t('panel-error-title')}</Text>
          <Box height={1} />
          <Text dimColor wrap="truncate-end">{message}</Text>
          <Box height={1} />
          <Text dimColor>{t('panel-error-hint')}</Text>
        </Box>
      )
    }
    return this.props.children
  }
}
