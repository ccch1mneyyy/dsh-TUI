/**
 * Typing shims for the ported Ink core and dsh-tui additions.
 *
 * This file is a MODULE (top-level import) so every `declare module` block is
 * a module augmentation that merges with the real declarations — a global
 * script file would shadow them instead.
 */
import type {} from 'react'

// The published Claude Code source was transformed by the React Compiler:
// components are `function X(t0)` and import the compiler runtime's `c`
// helper (an effect-slot array). @types/react does not declare the
// compiler-runtime subpath.
declare module 'react/compiler-runtime' {
  export function c(size: number): any[]
}

// The fork renders custom DOM element names for its reconciler; the original
// source's global.d.ts (which declared them) is not part of the leak.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': unknown
      'ink-text': unknown
      'ink-link': unknown
      'ink-raw': unknown
      'ink-raw-ansi': unknown
    }
  }
}

// The ported core probes Bun's fast string-width/wrap implementations at
// module scope; dsh-tui runs on Node, where the probes must stay inert.
declare global {
  const Bun: any
}

// `session/title` records are appended by the optional dsh-session-title
// plugin; declare the record here so the channel can render it without that
// dependency (mirrors the plugin's own merge-extensible augmentation).
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'session/title': { title: string }
  }
}
