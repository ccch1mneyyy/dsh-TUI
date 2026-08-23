/**
 * dsh facade for the vendored pi-tui fork (`@deepseek-harness-tui/pi-tui`).
 *
 * This module is the ONLY import path production code may use for pi-tui
 * (docs/pi-tui-adoption-refactor-plan.md §1.1/§4). It re-exports exactly the
 * fork public API surface dsh consumes and adds no behavior of its own.
 * Never import `@earendil-works/pi-tui` or fork-private paths directly.
 *
 * One deliberate exception: the layout-node contract below. The fork's
 * package root does not export `LAYOUT_NODE`/`LayoutNode` and the boundary
 * pins this facade to the root specifier, so the same global-registry symbol
 * is re-declared here (`Symbol.for` identity is exactly what pi-tui's
 * `getLayoutNode()` looks up) alongside structural mirrors of the node types.
 */
import type { Component } from '@deepseek-harness-tui/pi-tui'

export {
  Box,
  CancellableLoader,
  Container,
  CURSOR_MARKER,
  decodeKittyPrintable,
  Editor,
  HStack,
  Input,
  isFocusable,
  isKeyRelease,
  isKeyRepeat,
  isViewportTUI,
  Key,
  Loader,
  Markdown,
  matchesKey,
  parseKey,
  ProcessTerminal,
  ScrollView,
  SelectList,
  SettingsList,
  Spacer,
  Text,
  TruncatedText,
  TuiAltScreen,
  TuiMainScreen,
  visibleWidth,
  truncateToWidth,
  sliceByColumn,
  stripTerminalSequences,
  wrapTextWithAnsi,
  VStack,
} from '@deepseek-harness-tui/pi-tui'
export type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
  Component,
  EditorComponent,
  EditorOptions,
  EditorTheme,
  Focusable,
  MarkdownOptions,
  MarkdownTheme,
  OverlayHandle,
  OverlayOptions,
  ScrollViewOptions,
  SelectItem,
  SelectListTheme,
  SettingItem,
  SettingsListTheme,
  SlashCommand,
  StackChild,
  StackEntry,
  StackEntryOptions,
  StackOptions,
  Terminal,
  TUI,
  TuiAltScreenOptions,
  TuiInputListener,
  TuiInputListenerResult,
  TuiMode,
  TuiStopOptions,
  ViewportTUI,
} from '@deepseek-harness-tui/pi-tui'

/**
 * pi-tui's layout-node symbol (packages/pi-tui/src/layout-node.ts). See the
 * module header for why this is re-declared instead of re-exported.
 */
export const LAYOUT_NODE = Symbol.for('@earendil-works/pi-tui/layout-node')

/** Structural mirror of pi-tui's `LayoutViewport`. */
export interface LayoutViewport {
  width: number
  height: number
}

/** Structural mirror of pi-tui's `StackLayoutEntry`. */
export interface StackLayoutEntry {
  component: Component
  basis?: number | 'auto'
  grow?: number
  shrink?: number
  minSize?: number
  maxSize?: number
  visible?: (viewport: LayoutViewport) => boolean
}

/** Structural mirror of pi-tui's `StackLayoutNode`. */
export interface StackLayoutNode {
  type: 'vstack' | 'hstack'
  entries: readonly StackLayoutEntry[]
  gap: number
  align: 'stretch' | 'start' | 'center' | 'end'
}

/** Structural mirror of pi-tui's `ScrollLayoutNode`; the `state` handle is
 *  pi-tui-internal and only consumed by its layout engine, so it stays
 *  unmodeled here. */
export interface ScrollLayoutNode {
  type: 'scroll'
  component: Component
}

export type LayoutNode = StackLayoutNode | ScrollLayoutNode

/** A component that exposes a layout node to pi-tui's alt-screen engine. */
export interface LayoutComponent {
  [LAYOUT_NODE](): LayoutNode
}

/** Local mirror of pi-tui's `getLayoutNode()`. */
export function getLayoutNode(component: Component): LayoutNode | undefined {
  const candidate = component as Partial<LayoutComponent>
  return typeof candidate[LAYOUT_NODE] === 'function' ? candidate[LAYOUT_NODE]() : undefined
}
