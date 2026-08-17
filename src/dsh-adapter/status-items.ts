/** Provider-neutral status-bar item registry for terminal front doors. */

import { Context, Service } from '@deepseek-ai/cordis'

/**
 * A single status-bar entry contributed by a plugin. Items are plain text —
 * the TUI owns layout, separators and truncation; a plugin only supplies the
 * label and an optional color name from the TUI's theme palette (the same
 * names `Text`'s `color` prop accepts).
 */
export interface TuiStatusItem {
  /** Unique within its provider; used as the render key. */
  id: string
  /** Compact label; keep it short — crowded footers truncate trailing fields. */
  text: string
  /** Optional theme color name (e.g. 'warning', 'professionalBlue'). */
  color?: string
  /** Render dimmed instead of at the default soft white. */
  dimColor?: boolean
}

/**
 * A plugin's contribution to the status bar. `items()` is read on every
 * render; `subscribe` must fire whenever the returned list changes so the
 * TUI repaints promptly (connection flaps, latency updates, …).
 */
export interface TuiStatusItemsProvider {
  items(): readonly TuiStatusItem[]
  subscribe(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiStatusItems: TuiStatusItemsRuntime
  }
}

export const name = 'dsh-tui-status-items'

/**
 * Small host-only registry; the StatusLine footer remains owned by the TUI.
 *
 * A plugin registers a provider once (`ctx.tuiStatusItems.register(...)`,
 * keep the dispose). Items render in registration order after the built-in
 * model/tps fields; absent the service (stale bundle patch or a bare
 * embedder), the footer simply shows no plugin items.
 */
export class TuiStatusItemsRuntime extends Service {
  private readonly providers = new Set<TuiStatusItemsProvider>()
  private readonly listeners = new Set<() => void>()
  private readonly providerUnsubscribes = new Map<TuiStatusItemsProvider, () => void>()

  constructor(ctx: Context) {
    super(ctx, 'tuiStatusItems')
  }

  register(provider: TuiStatusItemsProvider): () => void {
    if (this.providers.has(provider)) throw new Error('TUI status-items provider is already registered')
    this.providers.add(provider)
    this.providerUnsubscribes.set(provider, provider.subscribe(() => this.notify()))
    this.notify()
    return () => {
      if (!this.providers.delete(provider)) return
      this.providerUnsubscribes.get(provider)?.()
      this.providerUnsubscribes.delete(provider)
      this.notify()
    }
  }

  /** Every registered provider's items, in registration order. */
  items(): readonly TuiStatusItem[] {
    const items: TuiStatusItem[] = []
    for (const provider of this.providers) items.push(...provider.items())
    return items
  }

  /** UI-side change feed: fired after every register/dispose/provider update. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export default TuiStatusItemsRuntime
