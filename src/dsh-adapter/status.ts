/**
 * Keyed status-line contributions — pi's `ctx.ui.setStatus(key, text)`.
 * Each plugin owns a key; setting text shows it, setting undefined clears
 * it. The TUI renders all contributions as one joined line above the prompt
 * (host-owned rendering: plugins supply text, never layout).
 *
 * Same split as the dialogs seam: a cordis-free store the chat screen
 * subscribes to, and a thin cordis service validating untrusted text.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { stringWidth } from '../ink/stringWidth.js'

/** One rendered contribution. */
export interface TuiStatusEntry {
  readonly key: string
  readonly text: string
}

const KEY_PATTERN = /^[a-z][a-z0-9_-]*$/u
const TEXT_CELLS = 200
const MAX_ENTRIES = 20

/** Cordis-free keyed-text store. Render order is first-set order (Map
 *  insertion order), so a plugin's line never jumps around on updates. */
export class TuiStatusStore {
  private readonly listeners = new Set<() => void>()
  private readonly entries = new Map<string, string>()
  // useSyncExternalStore requires a referentially stable snapshot between
  // emits — a fresh array per call would re-render in an infinite loop.
  private snapshot: readonly TuiStatusEntry[] = []

  /** Set or clear (undefined/empty) one key. */
  set(key: string, text: string | undefined): void {
    const had = this.entries.has(key)
    if (text === undefined || text === '') {
      if (!had) return
      this.entries.delete(key)
    } else {
      if (this.entries.get(key) === text) return
      this.entries.set(key, text)
    }
    this.snapshot = [...this.entries].map(([entryKey, entryText]) => ({ key: entryKey, text: entryText }))
    this.emit()
  }

  /** Current contributions, first-set first (stable between changes). */
  getSnapshot(): readonly TuiStatusEntry[] {
    return this.snapshot
  }

  /** Clear `key` only while it still holds `text` — a stale disposer must
   *  not wipe a newer contribution set after it was created. */
  clearIf(key: string, text: string | undefined): void {
    if (text === undefined) return
    if (this.entries.get(key) !== text) return
    this.entries.delete(key)
    this.snapshot = [...this.entries].map(([entryKey, entryText]) => ({ key: entryKey, text: entryText }))
    this.emit()
  }

  /** Drop everything (teardown). */
  clear(): void {
    if (this.entries.size === 0) return
    this.entries.clear()
    this.snapshot = []
    this.emit()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiStatus: TuiStatusRuntime
  }
}

/**
 * `ctx.tuiStatus` — plugin-facing status contributions. Invalid keys and
 * oversized text are rejected with a logger warning instead of throwing:
 * a status line must never take the TUI down.
 */
export class TuiStatusRuntime extends Service {
  /** The store the chat screen renders. Exposed for the host, not plugins. */
  readonly store = new TuiStatusStore()

  constructor(ctx: Context) {
    super(ctx, 'tuiStatus')
    ctx.effect(() => () => this.store.clear())
  }

  /**
   * Set (or clear with `undefined`) the contribution for `key`. Keys are
   * plugin-namespaced by convention (`my-plugin`, `my-plugin:detail`);
   * control chars are stripped and text is capped at 200 cells.
   *
   * Returns a disposer that clears the contribution IF the key still holds
   * exactly this text (a later set wins over a stale disposer). The CALLER
   * scopes it to its own fiber (`ctx.effect(() => dispose)`) — the same
   * contract as `tuiShortcuts`/`tuiScenes`: a service method only sees the
   * service's own ctx, so per-plugin cleanup cannot happen here. Without
   * that, an unloaded or hot-reloaded plugin would leave its line behind
   * forever.
   */
  set(key: string, text: string | undefined): () => void {
    const noop = (): void => {}
    const normalized = String(key ?? '').trim().toLowerCase()
    if (!KEY_PATTERN.test(normalized)) {
      this.ctx.logger.warn(`dsh-tui: tuiStatus.set rejected invalid key ${JSON.stringify(key)}`)
      return noop
    }
    if (text !== undefined && !this.store.getSnapshot().some(e => e.key === normalized)) {
      // New key beyond the cap: the line is one row of terminal — an
      // unbounded count would push the prompt off screen.
      if (this.store.getSnapshot().length >= MAX_ENTRIES) {
        this.ctx.logger.warn(`dsh-tui: tuiStatus.set rejected "${normalized}": ${MAX_ENTRIES} contributions already shown`)
        return noop
      }
    }
    let cleaned: string | undefined
    if (text !== undefined) {
      // eslint-disable-next-line no-control-regex -- deliberate: sanitize untrusted render-path text
      const flat = String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
      if (stringWidth(flat) > TEXT_CELLS) {
        cleaned = ''
        for (const ch of flat) {
          if (stringWidth(cleaned + ch) > TEXT_CELLS - 1) break
          cleaned += ch
        }
        cleaned = `${cleaned}…`
      } else {
        cleaned = flat
      }
    }
    this.store.set(normalized, cleaned)
    return () => this.store.clearIf(normalized, cleaned)
  }
}

export default TuiStatusRuntime
