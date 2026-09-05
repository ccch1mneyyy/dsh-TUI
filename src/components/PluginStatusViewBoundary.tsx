/**
 * Error boundary for rich `tuiStatus` views. These components are trusted
 * in-process plugin code, but one broken render must collapse only its own
 * compact view instead of reaching Ink's app-level boundary and taking down
 * the conversation.
 *
 * As with plugin scenes, async callback/effect failures remain the plugin's
 * responsibility; React boundaries cover render and lifecycle failures.
 */
import React from 'react'

type PluginStatusViewBoundaryProps = {
  readonly viewKey: string
  readonly onError: (key: string, error: Error) => void
  readonly children: React.ReactNode
}

type PluginStatusViewBoundaryState = {
  readonly crashed: boolean
}

export class PluginStatusViewBoundary extends React.Component<
  PluginStatusViewBoundaryProps,
  PluginStatusViewBoundaryState
> {
  override state: PluginStatusViewBoundaryState = { crashed: false }

  static getDerivedStateFromError(): PluginStatusViewBoundaryState {
    return { crashed: true }
  }

  override componentDidCatch(error: Error): void {
    this.props.onError(this.props.viewKey, error)
  }

  override render(): React.ReactNode {
    return this.state.crashed ? null : this.props.children
  }
}
