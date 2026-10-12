/** Agent Domain barrel (docs/agent-backend-design.md): types plus tiny pure helpers. */
export * from './events.js'
export * from './session.js'
export * from './capabilities.js'
export * from './backend.js'
export * from './refs.js'
export * from './presentation.js'

// The view shapes a backend fills in when it emits events (`AgentEvent`
// payloads, `SessionCapabilities` answers, catalog rows). They are declared
// in `src/adapter/ports/` — the wire shapes the channel projects — and are
// re-exported here so a backend implementing against the public surface
// (`src/agent/`) never has to name `src/adapter/ports/` itself (B-3). Several
// Agent Domain modules already `import type` them, so this adds no runtime
// edge and no cycle: `src/adapter/ports/*` are pure declarations, and the
// edge has always pointed this way.
export type {
  AgentMessageState,
  AgentMessageView,
  TodoPanelItem,
  ToolFileDiff,
  TranscriptImage,
  WorkingActivityView,
} from '../adapter/ports/channel-view.js'
export type { PreviewEntry, SessionSummary } from '../adapter/ports/channel-session.js'
