// Host JSX factory for plugin scenes: re-exports the TUI's OWN
// react/jsx-runtime, so JSX a plugin compiles against this subpath produces
// React 19 elements (`Symbol.for('react.transitional.element')`) — the only
// element flavor this app's reconciler accepts. A plugin bundling its own
// older React emits `Symbol.for('react.element')` and dies on first render.
//
// Plugin tsconfig:
//   "jsx": "react-jsx",
//   "jsxImportSource": "@deepseek-harness-tui/dsh-tui"
//
// Hooks still come from the scene props' injected `React` — this module
// covers element creation only.
export * from 'react/jsx-runtime'
