/**
 * Synchronous root/overlay swap for the single root TUI (plan §1.2).
 *
 * Root changes never stop the terminal and never go through quiesce/resume:
 * inline swaps via `clear`/`addChild`, fullscreen via `setLayoutRoot`.
 * Stopping a `TuiAltScreen` (even with `preserveScreen`) leaves the alt
 * screen, so rebuilding it per scene switch would be wrong.
 *
 * The pinned 0.84.2 `ViewportTUI` exposes only `setLayoutRoot` — there is no
 * upstream getter/snapshot API — so the current layout root is tracked here
 * and the fork stays zero-diff (plan §3.2).
 */
import type { Component, TUI } from './public.js'
import { isViewportTUI } from './public.js'

/**
 * Opaque restore handle for a temporary takeover. The `root` variant carries
 * the layout root this class tracked for a fullscreen TUI; the `children`
 * variant snapshots the inline TUI's child list (Kimi `screen-takeover.ts`
 * shape).
 */
export type ScreenTakeoverToken =
  | { readonly kind: 'root'; readonly root: Component | undefined }
  | { readonly kind: 'children'; readonly children: readonly Component[] }

export class ScreenTakeover {
  private readonly ui: TUI
  /** Tracked layout root. Only meaningful on the fullscreen (viewport) path. */
  private layoutRoot: Component | undefined

  constructor(ui: TUI) {
    this.ui = ui
  }

  /**
   * Permanently replace the active root screen. Pure component swap: the
   * terminal keeps running and no lifecycle verb is involved.
   */
  setRoot(next: Component | undefined): void {
    if (isViewportTUI(this.ui)) {
      this.layoutRoot = next
      this.ui.setLayoutRoot(next)
      return
    }
    this.ui.clear()
    if (next !== undefined) this.ui.addChild(next)
  }

  /**
   * Temporarily hand the screen to `viewer` (session browser, settings, …).
   * `end(token)` restores exactly the previous root/children. Nesting works
   * by caller stack discipline: each `begin` returns its own token.
   */
  begin(viewer: Component): ScreenTakeoverToken {
    if (isViewportTUI(this.ui)) {
      const token: ScreenTakeoverToken = { kind: 'root', root: this.layoutRoot }
      this.setRoot(viewer)
      return token
    }
    const children = [...this.ui.children]
    this.ui.clear()
    this.ui.addChild(viewer)
    return { kind: 'children', children }
  }

  /** Restore the screen captured by the matching `begin`. */
  end(token: ScreenTakeoverToken): void {
    if (token.kind === 'root') {
      if (!isViewportTUI(this.ui)) return
      this.layoutRoot = token.root
      this.ui.setLayoutRoot(token.root)
      return
    }
    if (isViewportTUI(this.ui)) return
    this.ui.clear()
    for (const child of token.children) this.ui.addChild(child)
  }
}
