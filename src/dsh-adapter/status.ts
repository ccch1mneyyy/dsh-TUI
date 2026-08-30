/**
 * Keyed status contributions above the prompt.
 *
 * `set(key, text)` remains pi's scalar `ctx.ui.setStatus` seam: the host
 * sanitizes and joins every text contribution into one line. `registerView`
 * is the bounded rich companion for compact, pointer-only surfaces that need
 * host React and themed cells (for example a progress card). It deliberately
 * receives no input, channel, or raw-terminal capability.
 *
 * Same split as the dialogs seam: a cordis-free store the chat screen
 * subscribes to, and a thin cordis service validating untrusted input.
 */

import type React from 'react'
import { Context, Service } from '@deepseek-ai/cordis'
import { cleanScalarText } from './sanitize.js'
import { activationFiber, assertCallerContext, bindCallerEffect, compositionRoot, concreteService, requirePluginCaller } from './host-access.js'
import { componentIdentityOf } from './component-identity.js'

/** One rendered contribution. */
export interface TuiStatusEntry {
  readonly key: string
  readonly text: string
}

/** Maximum height a rich status contribution may request. */
export type TuiStatusViewMaxRows = 1 | 2 | 3

type TuiStatusViewForbiddenBoxProps =
  | 'ref'
  | 'tabIndex'
  | 'autoFocus'
  | 'onContextMenu'
  | 'onFocus'
  | 'onFocusCapture'
  | 'onBlur'
  | 'onBlurCapture'
  | 'onKeyDown'
  | 'onKeyDownCapture'
  | 'onWheel'

type TuiStatusViewBoxProps = Omit<
  React.ComponentProps<typeof import('../ui.js').Box>,
  TuiStatusViewForbiddenBoxProps
>

type TuiStatusViewTextProps = Omit<
  React.ComponentProps<typeof import('../ui.js').Text>,
  'ref'
>

type Assert<T extends true> = T
type _TuiStatusViewBoxForbidsGlobalInput = Assert<
  Extract<TuiStatusViewForbiddenBoxProps, keyof TuiStatusViewBoxProps> extends never
    ? true
    : false
>
type _TuiStatusViewBoxKeepsPointerAndLayout = Assert<
  Exclude<
    | 'children'
    | 'flexDirection'
    | 'onClick'
    | 'onDragStart'
    | 'onDragMove'
    | 'onDragEnd'
    | 'onMouseEnter'
    | 'onMouseLeave',
    keyof TuiStatusViewBoxProps
  > extends never
    ? true
    : false
>
type _TuiStatusViewTextForbidsRef = Assert<
  'ref' extends keyof TuiStatusViewTextProps ? false : true
>

/** Pointer-only host kit passed to rich status components. `Box` keeps local
 * click, hover, and captured-drag handlers, but cannot take focus, keyboard,
 * context-menu, wheel, or ref props. Raw-terminal APIs are absent. */
export interface TuiStatusViewUi {
  readonly Box: React.ComponentType<TuiStatusViewBoxProps>
  readonly Text: React.ComponentType<TuiStatusViewTextProps>
  readonly useTerminalSize: typeof import('../ui.js').useTerminalSize
}

/** Props for a rich status component. Hooks and elements must use the host
 * React instance, following the same single-React rule as plugin scenes. */
export interface TuiStatusViewProps {
  readonly React: typeof React
  readonly ui: TuiStatusViewUi
}

/** Cleanup handle returned for an admitted rich status registration. */
export type TuiStatusViewDisposer = () => void

/** One compact status view rendered above the prompt. Keyboard input is not
 * exposed; pointer interaction is available through `Box` click/hover/drag
 * handlers and should be paired with a slash command or separately registered
 * `tuiShortcuts` action. */
export interface TuiStatusViewDescriptor {
  readonly key: string
  /** Defaults to one row; the host clips every view at three rows. */
  readonly maxRows?: TuiStatusViewMaxRows
  readonly component: React.ComponentType<TuiStatusViewProps>
}

/** Host-side normalized registration. Kept out of the plugin export shim. */
export interface TuiStatusViewEntry {
  readonly key: string
  readonly maxRows: TuiStatusViewMaxRows
  readonly component: React.ComponentType<TuiStatusViewProps>
  /** Remounts the error boundary after a dispose + same-key re-registration. */
  readonly registrationId: number
}

// Colon-separated segments are the documented namespacing convention
// (`plugin:sub-item`); each segment stays a lowercase slug.
const KEY_PATTERN = /^[a-z][a-z0-9_-]*(:[a-z][a-z0-9_-]*)*$/u
const TEXT_CELLS = 200
const MAX_ENTRIES = 20
const MAX_VIEW_ROWS = 3
const MAX_VIEW_ROW_BUDGET = 6
const HOST_STATUS_OWNER = Object.freeze({ kind: 'host-status-owner' })

/** Cordis-free text + view store. Render order is first-set/register order
 * (Map insertion order), so plugin contributions do not jump on updates. */
export class TuiStatusStore {
  private readonly listeners = new Set<() => void>()
  // Each write carries a token: a disposer compares TOKENS, not text —
  // value comparison has an ABA hole (set 'x', set 'x' again, the first
  // disposer would wipe the second write, e.g. a hot reload restoring the
  // same status text).
  private readonly entries = new Map<string, { text: string; token: number; owner: object }>()
  private readonly views = new Map<string, { view: TuiStatusViewEntry; token: number; owner: object }>()
  // useSyncExternalStore requires a referentially stable snapshot between
  // emits — a fresh array per call would re-render in an infinite loop.
  private snapshot: readonly TuiStatusEntry[] = []
  private viewSnapshot: readonly TuiStatusViewEntry[] = []

  constructor(
    private readonly onViewError?: (key: string, error: Error) => void,
  ) {}

  /** Set or clear (undefined/empty) one key. */
  set(key: string, text: string | undefined, token = 0, owner: object = HOST_STATUS_OWNER): void {
    const had = this.entries.has(key)
    if (text === undefined || text === '') {
      if (!had) return
      this.entries.delete(key)
    } else {
      const existing = this.entries.get(key)
      if (existing?.text === text) {
        // Same text, new write: adopt the new token so the newest disposer
        // is the one that owns the line (no re-emit — nothing visible changed).
        existing.token = token
        return
      }
      this.entries.set(key, { text, token, owner })
    }
    this.snapshot = [...this.entries].map(([entryKey, entry]) => ({ key: entryKey, text: entry.text }))
    this.emit()
  }

  /** Current contributions, first-set first (stable between changes). */
  getSnapshot(): readonly TuiStatusEntry[] {
    return this.snapshot
  }

  /** Current rich contributions, first-registration first and referentially
   * stable between mutations for `useSyncExternalStore`. */
  getViewSnapshot(): readonly TuiStatusViewEntry[] {
    return this.viewSnapshot
  }

  /** Host runtime uses this to enforce that one activation cannot rewrite or
   * clear another activation's keyed contribution. */
  ownerOf(key: string): object | undefined {
    return this.entries.get(key)?.owner
  }

  viewOwnerOf(key: string): object | undefined {
    return this.views.get(key)?.owner
  }

  addView(view: TuiStatusViewEntry, token: number, owner: object): void {
    this.views.set(view.key, { view, token, owner })
    this.viewSnapshot = [...this.views.values()].map(entry => entry.view)
    this.emit()
  }

  clearViewIf(key: string, token: number, owner?: object): boolean {
    const current = this.views.get(key)
    if (owner !== undefined && current?.owner !== owner) return false
    if (current?.token !== token) return false
    this.views.delete(key)
    this.viewSnapshot = [...this.views.values()].map(entry => entry.view)
    this.emit()
    return true
  }

  /** Called only by the host-side error boundary. */
  reportViewError(key: string, error: Error): void {
    this.onViewError?.(key, error)
  }

  /** Clear `key` only while it still holds the write tagged `token` — a
   *  stale disposer must not wipe a newer contribution (even one with
   *  identical text). Returns true when this call actually cleared. */
  clearIf(key: string, token: number, owner?: object): boolean {
    if (owner !== undefined && this.entries.get(key)?.owner !== owner) return false
    if (this.entries.get(key)?.token !== token) return false
    this.entries.delete(key)
    this.snapshot = [...this.entries].map(([entryKey, entry]) => ({ key: entryKey, text: entry.text }))
    this.emit()
    return true
  }

  /** Drop everything (teardown). */
  clear(): void {
    if (this.entries.size === 0 && this.views.size === 0) return
    this.entries.clear()
    this.views.clear()
    this.snapshot = []
    this.viewSnapshot = []
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
 * a status contribution must never take the TUI down.
 */
export class TuiStatusRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tuiStatus')
    compositionRoot(ctx)
    // Keep host state out of the traceable service object. A WeakMap also
    // works with Cordis's caller-bound method proxy (unlike `#private`).
    const state: StatusState = {
      store: new TuiStatusStore((key, error) => {
        ctx.logger.warn(`dsh-tui: status view "${key}" crashed and was hidden: %o`, error)
      }),
      nextToken: 1,
    }
    hostStatusStores.set(this, state)
    ctx.effect(() => () => state.store.clear())
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
   * stale disposer). The host also removes that disposer from the caller's
   * Cordis effect list when it is invoked explicitly. Clearing with
   * `undefined` or empty text happens immediately and returns a no-op without
   * registering an owner effect.
   *
   * The optional trailing `identity` (the plugin's own ctx) only feeds the
   * effect ledger's pluginId — omitting it records `undeclared`, never a
   * guess (C-060 honest identity).
   */
  set(key: string, text: string | number | boolean | undefined, identity?: Context): () => void {
    const noop = (): void => {}
    let caller: Context
    try {
      caller = requirePluginCaller(this.ctx, 'tuiStatus.set', this)
    } catch {
      this.ctx.logger.warn('dsh-tui: tuiStatus.set requires a live non-root plugin activation')
      return noop
    }
    const state = statusStateFor(this)
    const store = state.store
    const callerIdentity = componentIdentityOf(caller)
    const suppliedIdentity = identity === undefined ? callerIdentity : componentIdentityOf(identity)
    if (identity !== undefined) {
      try {
        assertCallerContext(caller, identity, 'tuiStatus.set')
      } catch {
        caller.logger.warn('dsh-tui: tuiStatus.set rejected an identity belonging to another activation')
        return noop
      }
    }
    const owner = activationFiber(caller)
    if (owner === undefined) {
      caller.logger.warn('dsh-tui: tuiStatus.set requires a live activation owner')
      return noop
    }
    let normalized: string
    try {
      normalized = String(key ?? '').trim().toLowerCase()
    } catch {
      caller.logger.warn('dsh-tui: tuiStatus.set rejected an uncoercible key')
      return noop
    }
    if (!KEY_PATTERN.test(normalized)) {
      caller.logger.warn('dsh-tui: tuiStatus.set rejected an invalid key')
      return noop
    }
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
    if (cleaned !== undefined && store.viewOwnerOf(normalized) !== undefined) {
      caller.logger.warn(`dsh-tui: tuiStatus.set rejected "${normalized}" — the key already owns a rich view`)
      return noop
    }
    const had = store.getSnapshot().some(entry => entry.key === normalized)
    if (store.ownerOf(normalized) !== undefined && store.ownerOf(normalized) !== owner) {
      caller.logger.warn(`dsh-tui: tuiStatus.set rejected "${normalized}" — the contribution belongs to another activation`)
      return noop
    }
    const ledger = caller.get('tuiEffectLedger')
    if (cleaned === undefined || cleaned === '') {
      store.set(normalized, undefined, 0, owner)
      if (had) ledger?.record({ operation: 'release', resource: { kind: 'status', id: normalized }, result: 'applied' }, identity)
      return noop
    }
    const token = state.nextToken++
    store.set(normalized, cleaned, token, owner)
    let disposed = false
    let ledgerApplied = false
    let ownerCleanup: (() => unknown) | undefined
    const dispose = () => {
      if (disposed) return
      disposed = true
      if (store.clearIf(normalized, token, owner) && ledgerApplied) {
        caller.get('tuiEffectLedger')?.record(
          { operation: 'release', resource: { kind: 'status', id: normalized }, result: 'applied' },
          identity,
        )
      }
      const cleanup = ownerCleanup
      ownerCleanup = undefined
      cleanup?.()
    }
    const bound = bindCallerEffect(caller, dispose, cleanup => {
      ownerCleanup = cleanup
    })
    if (!bound) return noop
    ledger?.record(
      {
        operation: had ? 'replace' : 'bind',
        resource: { kind: 'status', id: normalized },
        result: 'applied',
        ...(had ? { replaces: { resourceId: normalized } } : {}),
      },
      identity,
    )
    ledgerApplied = true
    return dispose
  }

  /**
   * Register a compact React view above the prompt. The component receives
   * the host's React plus a pointer-only UI kit; it owns its live data via an
   * external store and is clipped by the host to `maxRows` (one by default,
   * three at most). Registrations share the text key namespace, preserve
   * first-registration order, and consume a six-row aggregate budget.
   *
   * Successful registrations return a cleanup-aware disposer. Refused
   * registrations warn and return `undefined`, so feature-detecting callers
   * can distinguish admission from rejection. The optional identity has the
   * same attribution-only meaning as `set()`.
   */
  registerView(descriptor: TuiStatusViewDescriptor, identity?: Context): TuiStatusViewDisposer | undefined {
    let caller: Context
    try {
      caller = requirePluginCaller(this.ctx, 'tuiStatus.registerView', this)
    } catch {
      this.ctx.logger.warn('dsh-tui: tuiStatus.registerView requires a live non-root plugin activation')
      return undefined
    }
    if (identity !== undefined) {
      try {
        assertCallerContext(caller, identity, 'tuiStatus.registerView')
      } catch {
        caller.logger.warn('dsh-tui: tuiStatus.registerView rejected an identity belonging to another activation')
        return undefined
      }
    }
    const owner = activationFiber(caller)
    if (owner === undefined) {
      caller.logger.warn('dsh-tui: tuiStatus.registerView requires a live activation owner')
      return undefined
    }
    if (typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor)) {
      caller.logger.warn('dsh-tui: tuiStatus.registerView rejected an invalid descriptor')
      return undefined
    }
    const raw = descriptor as unknown as {
      key?: unknown
      maxRows?: unknown
      component?: unknown
    }
    let normalized: string
    try {
      normalized = String(raw.key ?? '').trim().toLowerCase()
    } catch {
      caller.logger.warn('dsh-tui: tuiStatus.registerView rejected an uncoercible key')
      return undefined
    }
    if (!KEY_PATTERN.test(normalized)) {
      caller.logger.warn('dsh-tui: tuiStatus.registerView rejected an invalid key')
      return undefined
    }
    const maxRows = raw.maxRows ?? 1
    if (typeof maxRows !== 'number' || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_VIEW_ROWS) {
      caller.logger.warn(`dsh-tui: tuiStatus.registerView rejected "${normalized}" — maxRows must be an integer from 1 to ${MAX_VIEW_ROWS}`)
      return undefined
    }
    if (typeof raw.component !== 'function') {
      caller.logger.warn(`dsh-tui: tuiStatus.registerView rejected "${normalized}" — component must be a function`)
      return undefined
    }
    const state = statusStateFor(this)
    const store = state.store
    if (store.ownerOf(normalized) !== undefined || store.viewOwnerOf(normalized) !== undefined) {
      caller.logger.warn(`dsh-tui: tuiStatus.registerView rejected "${normalized}" — the key is already registered`)
      caller.get('tuiEffectLedger')?.record(
        {
          operation: 'bind',
          resource: { kind: 'status', id: normalized },
          result: 'failed',
          errorCode: 'DUPLICATE_CONTRIBUTION_ID',
        },
        identity,
      )
      return undefined
    }
    const requestedRows = store.getViewSnapshot().reduce(
      (rows, view) => rows + view.maxRows,
      maxRows,
    )
    if (requestedRows > MAX_VIEW_ROW_BUDGET) {
      caller.logger.warn(`dsh-tui: tuiStatus.registerView rejected "${normalized}" — rich status views are limited to ${MAX_VIEW_ROW_BUDGET} rows total`)
      return undefined
    }
    const token = state.nextToken++
    const view: TuiStatusViewEntry = Object.freeze({
      key: normalized,
      maxRows: maxRows as TuiStatusViewMaxRows,
      component: raw.component as React.ComponentType<TuiStatusViewProps>,
      registrationId: token,
    })
    store.addView(view, token, owner)
    let disposed = false
    let ledgerApplied = false
    let ownerCleanup: (() => unknown) | undefined
    const dispose = () => {
      if (disposed) return
      disposed = true
      if (store.clearViewIf(normalized, token, owner) && ledgerApplied) {
        caller.get('tuiEffectLedger')?.record(
          { operation: 'release', resource: { kind: 'status', id: normalized }, result: 'applied' },
          identity,
        )
      }
      const cleanup = ownerCleanup
      ownerCleanup = undefined
      cleanup?.()
    }
    const bound = bindCallerEffect(caller, dispose, cleanup => {
      ownerCleanup = cleanup
    })
    if (!bound) return undefined
    caller.get('tuiEffectLedger')?.record(
      { operation: 'bind', resource: { kind: 'status', id: normalized }, result: 'applied' },
      identity,
    )
    ledgerApplied = true
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
