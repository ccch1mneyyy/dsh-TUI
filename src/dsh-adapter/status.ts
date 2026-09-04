/**
 * Keyed status-line contributions — pi's `ctx.ui.setStatus(key, text)`.
 * Each plugin owns a key; setting text shows it, setting undefined clears
 * it. The TUI renders all contributions rightmost in the statusline row
 * (host-owned rendering: plugins supply text, never layout). `setStyled`
 * additionally accepts colored text runs (named palette, never raw ANSI).
 *
 * Same split as the dialogs seam: a cordis-free store the chat screen
 * subscribes to, and a thin cordis service validating untrusted text.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { cleanScalarText } from './sanitize.js'
import { stringWidth } from '../ink/stringWidth.js'
import { activationFiber, assertCallerContext, bindCallerEffect, compositionRoot, concreteService, requirePluginCaller } from './host-access.js'

/** One rendered contribution. */
export interface TuiStatusEntry {
  readonly key: string
  readonly text: string
  /** Styled text runs (`setStyled`); absent for plain `set()` contributions. */
  readonly segments?: readonly TuiStatusSegment[]
}

/**
 * A styled text run inside a `setStyled` contribution. Colors are Ink's
 * named colors (fixed whitelist, never raw ANSI); `weight` is bold or dim.
 * The TUI renders runs inline in contribution order.
 */
export interface TuiStatusSegment {
  readonly text: string
  readonly fg?: SegmentColor
  readonly bg?: SegmentColor
  readonly weight?: 'bold' | 'dim'
}

/** The named colors `setStyled` accepts — Ink's ANSI palette (the 8 base
 *  colors plus bright variants, `ansi:`-prefixed like every Color value). */
export type SegmentColor =
  | 'ansi:black'
  | 'ansi:red'
  | 'ansi:green'
  | 'ansi:yellow'
  | 'ansi:blue'
  | 'ansi:magenta'
  | 'ansi:cyan'
  | 'ansi:white'
  | 'ansi:blackBright'
  | 'ansi:redBright'
  | 'ansi:greenBright'
  | 'ansi:yellowBright'
  | 'ansi:blueBright'
  | 'ansi:magentaBright'
  | 'ansi:cyanBright'
  | 'ansi:whiteBright'

// Colon-separated segments are the documented namespacing convention
// (`plugin:sub-item`); each segment stays a lowercase slug.
const KEY_PATTERN = /^[a-z][a-z0-9_-]*(:[a-z][a-z0-9_-]*)*$/u
const TEXT_CELLS = 200
const MAX_ENTRIES = 20
const MAX_SEGMENTS = 32
const SEGMENT_COLORS = new Set<SegmentColor>([
  'ansi:black', 'ansi:red', 'ansi:green', 'ansi:yellow',
  'ansi:blue', 'ansi:magenta', 'ansi:cyan', 'ansi:white',
  'ansi:blackBright', 'ansi:redBright', 'ansi:greenBright', 'ansi:yellowBright',
  'ansi:blueBright', 'ansi:magentaBright', 'ansi:cyanBright', 'ansi:whiteBright',
])
const HOST_STATUS_OWNER = Object.freeze({ kind: 'host-status-owner' })

/** Cordis-free keyed-text store. Render order is first-set order (Map
 *  insertion order), so a plugin's line never jumps around on updates. */
export class TuiStatusStore {
  private readonly listeners = new Set<() => void>()
  // Each write carries a token: a disposer compares TOKENS, not text —
  // value comparison has an ABA hole (set 'x', set 'x' again, the first
  // disposer would wipe the second write, e.g. a hot reload restoring the
  // same status text).
  private readonly entries = new Map<string, { text: string; segments?: readonly TuiStatusSegment[]; token: number; owner: object }>()
  // useSyncExternalStore requires a referentially stable snapshot between
  // emits — a fresh array per call would re-render in an infinite loop.
  private snapshot: readonly TuiStatusEntry[] = []

  /** Rebuild the frozen snapshot from the entries map (styled entries carry
   *  their segments). */
  private rebuildSnapshot(): void {
    this.snapshot = [...this.entries].map(([entryKey, entry]) => ({
      key: entryKey,
      text: entry.text,
      ...(entry.segments !== undefined ? { segments: entry.segments } : {}),
    }))
  }

  /** Set or clear (undefined/empty) one key. */
  set(key: string, text: string | undefined, token = 0, owner: object = HOST_STATUS_OWNER): void {
    const had = this.entries.has(key)
    if (text === undefined || text === '') {
      if (!had) return
      this.entries.delete(key)
    } else {
      const existing = this.entries.get(key)
      if (existing?.text === text && existing.segments === undefined) {
        // Same text, new write: adopt the new token so the newest disposer
        // is the one that owns the line (no re-emit — nothing visible changed).
        existing.token = token
        return
      }
      this.entries.set(key, { text, token, owner })
    }
    this.rebuildSnapshot()
    this.emit()
  }

  /** Set or clear (undefined/empty) one key with styled segments. */
  setStyled(key: string, segments: readonly TuiStatusSegment[] | undefined, token = 0, owner: object = HOST_STATUS_OWNER): void {
    const had = this.entries.has(key)
    if (segments === undefined || segments.length === 0) {
      if (!had) return
      this.entries.delete(key)
    } else {
      const text = segments.map(segment => segment.text).join('')
      const existing = this.entries.get(key)
      if (
        existing?.text === text &&
        existing.segments !== undefined &&
        existing.segments.length === segments.length &&
        existing.segments.every((segment, index) =>
          segment.text === segments[index].text &&
          segment.fg === segments[index].fg &&
          segment.bg === segments[index].bg &&
          segment.weight === segments[index].weight)
      ) {
        // Same runs, new write: adopt the new token (see set()).
        existing.token = token
        return
      }
      this.entries.set(key, { text, segments, token, owner })
    }
    this.rebuildSnapshot()
    this.emit()
  }

  /** Current contributions, first-set first (stable between changes). */
  getSnapshot(): readonly TuiStatusEntry[] {
    return this.snapshot
  }

  /** Host runtime uses this to enforce that one activation cannot rewrite or
   * clear another activation's keyed contribution. */
  ownerOf(key: string): object | undefined {
    return this.entries.get(key)?.owner
  }

  /** Clear `key` only while it still holds the write tagged `token` — a
   *  stale disposer must not wipe a newer contribution (even one with
   *  identical text). Returns true when this call actually cleared. */
  clearIf(key: string, token: number, owner?: object): boolean {
    if (owner !== undefined && this.entries.get(key)?.owner !== owner) return false
    if (this.entries.get(key)?.token !== token) return false
    this.entries.delete(key)
    this.rebuildSnapshot()
    this.emit()
    return true
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
  constructor(ctx: Context) {
    super(ctx, 'tuiStatus')
    compositionRoot(ctx)
    // Keep host state out of the traceable service object. A WeakMap also
    // works with Cordis's caller-bound method proxy (unlike `#private`).
    const state: StatusState = { store: new TuiStatusStore(), nextToken: 1 }
    hostStatusStores.set(this, state)
    ctx.effect(() => () => state.store.clear())
  }

  /** Shared `set`/`setStyled` preamble: resolve the writing activation and
   *  its owner, or null after logging when the write must be refused. */
  private resolveWrite(method: 'set' | 'setStyled', identity?: Context): { caller: Context; owner: object } | null {
    let caller: Context
    try {
      caller = requirePluginCaller(this.ctx, `tuiStatus.${method}`, this)
    } catch {
      this.ctx.logger.warn(`dsh-tui: tuiStatus.${method} requires a live non-root plugin activation`)
      return null
    }
    if (identity !== undefined) {
      try {
        assertCallerContext(caller, identity, `tuiStatus.${method}`)
      } catch {
        caller.logger.warn(`dsh-tui: tuiStatus.${method} rejected an identity belonging to another activation`)
        return null
      }
    }
    const owner = activationFiber(caller)
    if (owner === undefined) {
      caller.logger.warn(`dsh-tui: tuiStatus.${method} requires a live activation owner`)
      return null
    }
    return { caller, owner }
  }

  /** Shared key normalization for `set`/`setStyled`; null after logging. */
  private normalizeKey(caller: Context, method: 'set' | 'setStyled', key: string): string | null {
    let normalized: string
    try {
      normalized = String(key ?? '').trim().toLowerCase()
    } catch {
      caller.logger.warn(`dsh-tui: tuiStatus.${method} rejected an uncoercible key`)
      return null
    }
    if (!KEY_PATTERN.test(normalized)) {
      caller.logger.warn(`dsh-tui: tuiStatus.${method} rejected an invalid key`)
      return null
    }
    return normalized
  }

  /**
   * Set (or clear with `undefined`) the contribution for `key`. Keys are
   * plugin-namespaced by convention (`my-plugin`, `my-plugin:detail`);
   * control chars are stripped and text is capped at 200 cells. Text is
   * scalar-only: string/number/boolean are coerced to string, anything else
   * is refused with a warning (never rendered as "[object Object]", never
   * silently treated as a clear).
   *
   * Returns a disposer that clears the contribution IF the key still holds
   * exactly this write (a later set — even of identical text — wins over a
   * stale disposer). The CALLER scopes it to its own fiber
   * (`ctx.effect(() => dispose)`) — the same contract as
   * `tuiShortcuts`/`tuiScenes`: a service method only sees the service's own
   * ctx, so per-plugin cleanup cannot happen here. Without that, an unloaded
   * or hot-reloaded plugin would leave its line behind forever.
   *
   * The optional trailing `identity` (the plugin's own ctx) only feeds the
   * effect ledger's pluginId — omitting it records `undeclared`, never a
   * guess (C-060 honest identity).
   */
  set(key: string, text: string | number | boolean | undefined, identity?: Context): () => void {
    const noop = (): void => {}
    const resolved = this.resolveWrite('set', identity)
    if (resolved === null) return noop
    const { caller, owner } = resolved
    const state = statusStateFor(this)
    const store = state.store
    const normalized = this.normalizeKey(caller, 'set', key)
    if (normalized === null) return noop
    if (text !== undefined && !store.getSnapshot().some(e => e.key === normalized)) {
      // New key beyond the cap: the line is one row of terminal — an
      // unbounded count would push the prompt off screen.
      if (store.getSnapshot().length >= MAX_ENTRIES) {
        caller.logger.warn(`dsh-tui: tuiStatus.set rejected "${normalized}": ${MAX_ENTRIES} contributions already shown`)
        return noop
      }
    }
    let cleaned: string | undefined
    if (text !== undefined) {
      // Scalar-only coercion (Track A contract): a non-scalar text (an
      // object would otherwise render as "[object Object]") is REFUSED with
      // a warning — it must not silently become a clear, either.
      if (typeof text !== 'string' && typeof text !== 'number' && typeof text !== 'boolean') {
        caller.logger.warn(`dsh-tui: tuiStatus.set rejected non-scalar text for "${normalized}"`)
        return noop
      }
      cleaned = cleanScalarText(text, TEXT_CELLS)
    }
    const token = state.nextToken++
    const had = store.getSnapshot().some(entry => entry.key === normalized)
    if (store.ownerOf(normalized) !== undefined && store.ownerOf(normalized) !== owner) {
      caller.logger.warn(`dsh-tui: tuiStatus.set rejected "${normalized}" — the contribution belongs to another activation`)
      return noop
    }
    store.set(normalized, cleaned, token, owner)
    const ledger = caller.get('tuiEffectLedger')
    if (cleaned === undefined) {
      if (had) ledger?.record({ operation: 'release', resource: { kind: 'status', id: normalized }, result: 'applied' }, identity)
    } else {
      ledger?.record(
        {
          operation: had ? 'replace' : 'bind',
          resource: { kind: 'status', id: normalized },
          result: 'applied',
          ...(had ? { replaces: { resourceId: normalized } } : {}),
        },
        identity,
      )
    }
    const dispose = () => {
      if (store.clearIf(normalized, token, owner)) {
        caller.get('tuiEffectLedger')?.record(
          { operation: 'release', resource: { kind: 'status', id: normalized }, result: 'applied' },
          identity,
        )
      }
    }
    bindCallerEffect(caller, dispose)
    return dispose
  }

  /**
   * Set (or clear with `undefined`/`[]`) a STYLED contribution for `key` —
   * the colored counterpart of {@link set}. `segments` is a list of text
   * runs rendered inline, rightmost in the statusline row; each run may
   * carry an Ink foreground/background color from the named palette and a
   * bold/dim weight. Control chars are stripped per run and the whole line
   * is capped at 200 cells; unknown colors/weights and non-string texts are
   * refused with a warning (never silently rendered as a clear).
   *
   * Same key/owner/cap validation, ledger accounting and disposer contract
   * as {@link set}; the `identity` argument feeds the effect ledger exactly
   * as in {@link set}. Plugins capability-detect this method
   * (`typeof ctx.tuiStatus.setStyled === 'function'`) to degrade to plain
   * `set()` on older TUIs.
   */
  setStyled(key: string, segments: readonly TuiStatusSegment[] | undefined, identity?: Context): () => void {
    const noop = (): void => {}
    const resolved = this.resolveWrite('setStyled', identity)
    if (resolved === null) return noop
    const { caller, owner } = resolved
    const state = statusStateFor(this)
    const store = state.store
    const normalized = this.normalizeKey(caller, 'setStyled', key)
    if (normalized === null) return noop
    if (segments !== undefined && !store.getSnapshot().some(e => e.key === normalized)) {
      // New key beyond the cap: the line is one row of terminal — an
      // unbounded count would push the prompt off screen.
      if (store.getSnapshot().length >= MAX_ENTRIES) {
        caller.logger.warn(`dsh-tui: tuiStatus.setStyled rejected "${normalized}": ${MAX_ENTRIES} contributions already shown`)
        return noop
      }
    }
    let cleaned: readonly TuiStatusSegment[] | undefined
    if (segments !== undefined) {
      if (!Array.isArray(segments) || segments.length > MAX_SEGMENTS) {
        caller.logger.warn(`dsh-tui: tuiStatus.setStyled rejected invalid segments for "${normalized}"`)
        return noop
      }
      if (segments.length > 0) {
        const runs: TuiStatusSegment[] = []
        let width = 0
        for (const raw of segments) {
          if (raw === null || typeof raw !== 'object' || typeof raw.text !== 'string') {
            caller.logger.warn(`dsh-tui: tuiStatus.setStyled rejected a non-string segment for "${normalized}"`)
            return noop
          }
          const fg = raw.fg === undefined ? undefined : typeof raw.fg === 'string' && SEGMENT_COLORS.has(raw.fg as SegmentColor) ? raw.fg : null
          const bg = raw.bg === undefined ? undefined : typeof raw.bg === 'string' && SEGMENT_COLORS.has(raw.bg as SegmentColor) ? raw.bg : null
          const weight = raw.weight === undefined ? undefined : raw.weight === 'bold' || raw.weight === 'dim' ? raw.weight : null
          if (fg === null || bg === null || weight === null) {
            caller.logger.warn(`dsh-tui: tuiStatus.setStyled rejected an unknown color/weight for "${normalized}"`)
            return noop
          }
          const text = cleanScalarText(raw.text, TEXT_CELLS)
          const runWidth = stringWidth(text)
          if (runs.length > 0 && width + runWidth > TEXT_CELLS) {
            caller.logger.warn(`dsh-tui: tuiStatus.setStyled truncated "${normalized}" at ${TEXT_CELLS} cells`)
            break
          }
          width += runWidth
          runs.push({
            text,
            ...(fg !== undefined ? { fg } : {}),
            ...(bg !== undefined ? { bg } : {}),
            ...(weight !== undefined ? { weight } : {}),
          })
        }
        if (runs.length > 0) cleaned = runs
      }
    }
    const token = state.nextToken++
    const had = store.getSnapshot().some(entry => entry.key === normalized)
    if (store.ownerOf(normalized) !== undefined && store.ownerOf(normalized) !== owner) {
      caller.logger.warn(`dsh-tui: tuiStatus.setStyled rejected "${normalized}" — the contribution belongs to another activation`)
      return noop
    }
    store.setStyled(normalized, cleaned, token, owner)
    const ledger = caller.get('tuiEffectLedger')
    if (cleaned === undefined) {
      if (had) ledger?.record({ operation: 'release', resource: { kind: 'status', id: normalized }, result: 'applied' }, identity)
    } else {
      ledger?.record(
        {
          operation: had ? 'replace' : 'bind',
          resource: { kind: 'status', id: normalized },
          result: 'applied',
          ...(had ? { replaces: { resourceId: normalized } } : {}),
        },
        identity,
      )
    }
    const dispose = () => {
      if (store.clearIf(normalized, token, owner)) {
        caller.get('tuiEffectLedger')?.record(
          { operation: 'release', resource: { kind: 'status', id: normalized }, result: 'applied' },
          identity,
        )
      }
    }
    bindCallerEffect(caller, dispose)
    return dispose
  }
}

/** Host-only status store accessor; not part of the package export map. */
interface StatusState {
  readonly store: TuiStatusStore
  nextToken: number
}

const hostStatusStores = new WeakMap<TuiStatusRuntime, StatusState>()

function statusStateFor(runtime: TuiStatusRuntime): StatusState {
  const store = hostStatusStores.get(concreteService(runtime))
  if (store === undefined) throw new Error('tuiStatus host store is unavailable')
  return store
}

export function getHostStatusStore(runtime: TuiStatusRuntime | undefined): TuiStatusStore | undefined {
  if (runtime === undefined) return undefined
  try {
    return hostStatusStores.get(concreteService(runtime))?.store
  } catch {
    return undefined
  }
}

export default TuiStatusRuntime
