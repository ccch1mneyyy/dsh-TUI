/**
 * Public rendering surface, themed for dsh-tui.
 *
 * `Box` and `Text` are theme-aware wrappers around the local renderer, so
 * components can use `color="subtle"`-style semantic theme keys consistently.
 */
export { default as render, renderSync, createRoot } from './ink/root.js'
export type { RenderOptions, Instance, Root } from './ink/root.js'
export { ThemeProvider, useTheme } from './components/design-system/ThemeProvider.js'
export { default as Box } from './components/design-system/ThemedBox.js'
export { default as Text } from './components/design-system/ThemedText.js'
export { default as Spacer } from './ink/components/Spacer.js'
export { default as Newline, type Props as NewlineProps } from './ink/components/Newline.js'
export { NoSelect } from './ink/components/NoSelect.js'
export { default as Image, type ImageProps } from './ink/components/Image.js'
export type { TerminalImageSource } from './ink/terminal-image.js'
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
export { useTerminalImages, useTerminalImageCellSize } from './ink/hooks/use-terminal-images.js'
export { useBlink } from './hooks/useBlink.js'
export { Ansi } from './ink/Ansi.js'
export type { Key } from './ink/events/input-event.js'
