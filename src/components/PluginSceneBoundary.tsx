/**
 * Error boundary for plugin scenes (dsh-tui-scenes). A scene component is
 * third-party code rendered inside Chat's tree: without a boundary a render
 * error propagates to ink's app-level boundary (src/ink/components/App.tsx)
 * and takes the whole TUI down with it. Catching here collapses the blast
 * radius to the scene itself — the host reports the error to the transcript
 * and closes the scene, landing the user back on the conversation.
 *
 * Boundaries catch render/lifecycle errors only; errors thrown from async
 * handlers and effects remain the scene's own responsibility (see the
 * 场景红线 section in docs/plugins.md).
 */
import React from 'react'

type PluginSceneBoundaryProps = {
  /** Scene id, echoed into the error report. */
  readonly id: string
  /** Called once per caught error; the host reports it and closes the scene. */
  readonly onError: (id: string, error: Error) => void
  readonly children: React.ReactNode
}

type PluginSceneBoundaryState = {
  readonly crashed: boolean
}

export class PluginSceneBoundary extends React.Component<
  PluginSceneBoundaryProps,
  PluginSceneBoundaryState
> {
  override state: PluginSceneBoundaryState = { crashed: false }

  static getDerivedStateFromError(): PluginSceneBoundaryState {
    // Suppress the scene's next render. The host's onError closes the scene
    // in the same commit turn, so this null fallback normally never paints;
    // it exists only to keep a closed-nowhere crash from remounting the
    // throwing component in a loop.
    return { crashed: true }
  }

  override componentDidCatch(error: Error): void {
    this.props.onError(this.props.id, error)
  }

  override render(): React.ReactNode {
    return this.state.crashed ? null : this.props.children
  }
}
