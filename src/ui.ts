/**
 * Public surface of the ported Ink core, themed for dsh-tui.
 *
 * The original Claude Code source wrapped the Ink core in a themed facade
 * (`src/ink.ts` + design-system ThemedBox/ThemedText). dsh-tui does the same:
 * `Box`/`Text` here are the theme-aware versions, so every ported CC
 * component can use `color="subtle"`-style theme keys unchanged.
 */
export { default as render, renderSync, createRoot } from './ink/root.js'
export type { RenderOptions, Instance, Root } from './ink/root.js'
export { ThemeProvider, useTheme } from './components/design-system/ThemeProvider.js'
export { default as Box } from './components/design-system/ThemedBox.js'
export { default as Text } from './components/design-system/ThemedText.js'
export { default as Spacer } from './ink/components/Spacer.js'
export { default as Newline, type Props as NewlineProps } from './ink/components/Newline.js'
export { NoSelect } from './ink/components/NoSelect.js'
export { AlternateScreen } from './ink/components/AlternateScreen.js'
export {
  default as ScrollBox,
  type ScrollBoxProps,
  type ScrollBoxHandle,
} from './ink/components/ScrollBox.js'
export { default as useInput } from './ink/hooks/use-input.js'
export { useCopyOnSelect } from './ink/hooks/use-copy-on-select.js'
export { default as useStdin } from './ink/hooks/use-stdin.js'
export { default as useApp } from './ink/hooks/use-app.js'
export { useAnimationFrame } from './ink/hooks/use-animation-frame.js'
export { useTerminalSize } from './ink/hooks/use-terminal-size.js'
export { useBlink } from './hooks/useBlink.js'
export { Ansi } from './ink/Ansi.js'
export type { Key } from './ink/events/input-event.js'
