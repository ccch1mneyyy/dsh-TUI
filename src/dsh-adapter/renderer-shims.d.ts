/**
 * Type augmentations for the renderer and optional session metadata.
 *
 * This file is a MODULE (top-level import) so every `declare module` block is
 * a module augmentation that merges with the real declarations — a global
 * script file would shadow them instead.
 */
import type {} from 'react'

// Custom renderer JSX element declarations.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': unknown
      'ink-text': unknown
      'ink-link': unknown
      'ink-image': unknown
      'ink-raw': unknown
      'ink-raw-ansi': unknown
    }
  }
}

// `session/title` records are appended by the optional dsh-session-title
// plugin; declare the record here so the channel can render it without that
// dependency (mirrors the plugin's own merge-extensible augmentation).
//
// The payload is the full upstream `SessionTitleEventData`: the strict v4
// reader rejects a log whose `session/title` lacks `messageSeqs`/`source`
// (`title messageSeqs requires an array`, issue #1006), so both TUI writers
// build it through `userTitleData()`. `messageSeqs` is empty exactly when
// `source.kind === 'user'`.
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'session/title': {
      readonly title: string
      readonly messageSeqs: number[]
      readonly source: { readonly kind: 'fallback' | 'provider' | 'user'; readonly provider?: string; readonly model?: unknown }
    }
  }
}
