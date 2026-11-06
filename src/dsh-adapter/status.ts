/**
 * Keyed status contributions above the prompt.
 *
 * `set(key, text)` remains pi's scalar `ctx.ui.setStatus` seam: the host
 * sanitizes and joins every text contribution into one line. `registerView`
 * is the bounded rich companion for compact, pointer-only surfaces that need
 * host React and themed cells (for example a progress card). It deliberately
 * receives no input, channel, or raw-terminal capability. `setField` is the
 * footer sibling: one keyed text cell admitted into the prompt footer's
 * existing left/right groups, with the same lifecycle, ownership, token, and
 * ledger rules as `set()`.
 *
 * Same split as the dialogs seam: a cordis-free store the chat screen
 * subscribes to, and a thin cordis service validating untrusted input.
 */

import type React from 'react'
import { Context, Service } from '@deepseek-ai/cordis'
import { cleanScalarText, cleanStatusFieldText } from './sanitize.js'
import { activationFiber, assertCallerContext, bindCallerEffect, compositionRoot, concreteService, requirePluginCaller } from './host-access.js'
import {
  assertCapabilityShadowPolicy,
  type AdapterRuntimeOptions,
} from '../adapter/kernel/runtime.js'
import { adapterRuntimeFor } from '../adapter/kernel/runtime-context.js'
import type { TuiChartRowKit } from '../components/design-system/chartTypes.js'

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

type TuiStatusViewImageProps = React.ComponentProps<
  typeof import('../ui.js').Image
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
 * context-menu, wheel, or ref props. Raw-terminal APIs are absent. The
 * single-row chart kit (`StackedBar`, `Sparkline`, `Meter`, `format`,
 * `seriesColor`, `hashSeries`; experimental) rides along; multi-row charts do
 * not fit a view clipped at three rows and stay panel/scene-only. */
export interface TuiStatusViewUi extends TuiChartRowKit {
  readonly Box: React.ComponentType<TuiStatusViewBoxProps>
  readonly Image: React.ComponentType<TuiStatusViewImageProps>
  readonly Text: React.ComponentType<TuiStatusViewTextProps>
  readonly useTerminalSize: typeof import('../ui.js').useTerminalSize
}

// The chart members are the kit's narrowed wrappers: a status view gets the
// whole single-row subset, none of the multi-row primitives, and a bar whose
// props carry no ref/children (a host pass-through would reintroduce them).
type _TuiStatusViewUiCarriesRowKit = Assert<
  Exclude<keyof TuiChartRowKit, keyof TuiStatusViewUi> extends never ? true : false
>
type _TuiStatusViewUiOmitsMultiRowCharts = Assert<
  Extract<'ColumnChart' | 'Heatmap' | 'Legend' | 'Table', keyof TuiStatusViewUi> extends never
    ? true
    : false
>
type _TuiStatusViewChartsAreNarrowed = Assert<
  Extract<
    'ref' | 'children',
    | keyof React.ComponentProps<TuiStatusViewUi['StackedBar']>
    | keyof React.ComponentProps<TuiStatusViewUi['Sparkline']>
    | keyof React.ComponentProps<TuiStatusViewUi['Meter']>
  > extends never
    ? true
    : false
>


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

/** Where a plugin footer field joins the footer: the left group's tail, the
 *  right group's head, or the right group's tail. `right-tail` is the row's
 *  right edge in the split layout only: `statusBar.compact` (the default)
 *  merges both groups into one left-aligned chain, where the slots order that
 *  chain and the ctx chip / trailing free space stay to the field's right. */
export type TuiStatusFieldSlot = 'left-tail' | 'right-head' | 'right-tail'

/** Semantic theme tone for a footer field. Literal colours are refused so a
 *  plugin cannot paint a one-off cell that ignores the active theme. */
export type TuiStatusFieldTone = 'dim' | 'accent' | 'success' | 'warning' | 'error'

/** Options for `tuiStatus.setField`. Every key is optional; on update an
 *  omitted key keeps that field's previous value (a fresh key starts from the
 *  defaults documented below). */
export interface TuiStatusFieldOptions {
  /** Default `'left-tail'`. */
  readonly slot?: TuiStatusFieldSlot
  /** Default `'dim'`. */
  readonly tone?: TuiStatusFieldTone
  /** Hard text cap in terminal cells: default 16, clamped to 1…32. */
  readonly maxCells?: number
  /** Hide the field below this terminal width: default 0, clamped to 0…400. */
  readonly minColumns?: number
  /** Supplemental-row text shown while the pointer rests on the field,
   *  capped at 160 cells. Declaring `onClick` requires it. */
  readonly detail?: string
  /** Pointer click in fullscreen (mouse tracking) only. Declaring it without
   *  a non-empty `detail` is refused: a clickable cell owes an explanation. */
  readonly onClick?: () => void
}

/** Host-side normalized field. `onClick` is the host-WRAPPED handler (errors
 *  are logged and reported to the UI); this type stays inside the adapter. */
export interface TuiStatusFieldEntry {
  readonly key: string
  readonly text: string
  readonly slot: TuiStatusFieldSlot
  readonly tone: TuiStatusFieldTone
  readonly maxCells: number
  readonly minColumns: number
  readonly detail?: string
  readonly onClick?: () => void
}

/** Host-side admission record: the frozen entry, the token + owner a disposer
 *  checks, and the unwrapped click so an options-less update can reuse it. */
export interface TuiStatusFieldRecord {
  readonly entry: TuiStatusFieldEntry
  readonly token: number
  readonly owner: object
  readonly rawOnClick?: () => void
}

// Colon-separated segments are the documented namespacing convention
// (`plugin:sub-item`); each segment stays a lowercase slug.
const KEY_PATTERN = /^[a-z][a-z0-9_-]*(:[a-z][a-z0-9_-]*)*$/u
const TEXT_CELLS = 200
const MAX_ENTRIES = 20
const MAX_VIEW_ROWS = 3
const MAX_VIEW_ROW_BUDGET = 6
// Footer budget: six plugin cells total (the row is one terminal line), two
// per activation so one plugin cannot own the whole footer.
const MAX_FIELDS = 6
const MAX_FIELDS_PER_OWNER = 2
const FIELD_CELLS_DEFAULT = 16
const FIELD_CELLS_MAX = 32
const FIELD_DETAIL_CELLS = 160
const FIELD_MIN_COLUMNS_MAX = 400
const FIELD_SLOTS = new Set<TuiStatusFieldSlot>(['left-tail', 'right-head', 'right-tail'])
const FIELD_TONES = new Set<TuiStatusFieldTone>(['dim', 'accent', 'success', 'warning', 'error'])
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
  private readonly fields = new Map<string, TuiStatusFieldRecord>()
  // useSyncExternalStore requires a referentially stable snapshot between
  // emits — a fresh array per call would re-render in an infinite loop.
  private snapshot: readonly TuiStatusEntry[] = []
  private viewSnapshot: readonly TuiStatusViewEntry[] = []
  private fieldSnapshot: readonly TuiStatusFieldEntry[] = []
  private onFieldError: ((key: string, error: Error) => void) | undefined

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

  /** Current footer fields, first-set first and referentially stable between
   *  mutations for `useSyncExternalStore`. */
  getFieldSnapshot(): readonly TuiStatusFieldEntry[] {
    return this.fieldSnapshot
  }

  /** Store (or overwrite) one admitted field. Slot/option merging already
   *  happened in the service; the store only records normalized entries. */
  setField(entry: TuiStatusFieldEntry, token: number, owner: object, rawOnClick?: () => void): void {
    this.fields.set(entry.key, { entry, token, owner, ...(rawOnClick === undefined ? {} : { rawOnClick }) })
    this.fieldSnapshot = [...this.fields.values()].map(record => record.entry)
    this.emit()
  }

  /** The full admission record for `key` (read by the service to merge an
   *  update onto the previous options and to check ownership). */
  fieldEntry(key: string): TuiStatusFieldRecord | undefined {
    return this.fields.get(key)
  }

  fieldCount(): number {
    return this.fields.size
  }

  /** How many footer fields one activation currently owns (cap enforcement). */
  fieldsOwnedBy(owner: object): number {
    let count = 0
    for (const record of this.fields.values()) {
      if (record.owner === owner) count += 1
    }
    return count
  }

  /** Clear `key` only while it still holds this token AND owner. */
  clearFieldIf(key: string, token: number, owner?: object): boolean {
    const current = this.fields.get(key)
    if (owner !== undefined && current?.owner !== owner) return false
    if (current?.token !== token) return false
    this.fields.delete(key)
    this.fieldSnapshot = [...this.fields.values()].map(record => record.entry)
    this.emit()
    return true
  }

  /** UI-side handler for a plugin click that threw; the service logs first. */
  setFieldErrorHandler(handler?: (key: string, error: Error) => void): void {
    this.onFieldError = handler
  }

  reportFieldError(key: string, error: Error): void {
    this.onFieldError?.(key, error)
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
    if (this.entries.size === 0 && this.views.size === 0 && this.fields.size === 0) return
    this.entries.clear()
    this.views.clear()
    this.fields.clear()
    this.snapshot = []
    this.viewSnapshot = []
    this.fieldSnapshot = []
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
      runtime: adapterRuntimeFor(ctx),
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
    assertCapabilityShadowPolicy('host.status.set', statusStateFor(this).runtime.mode, statusStateFor(this).runtime.slices)
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
   * Insert (or update/clear) one keyed TEXT field in the prompt footer's
   * existing left/right groups — no new row, no plugin component. The field
   * keeps the same admission contract as `set()`: plugin caller, activation
   * ownership, token-based disposers, effect-ledger records, never throws.
   *
   * Unlike `set()`, footer fields are capped (six total, two per activation)
   * and each cell is truncated by the host to `maxCells` (default 16, at most
   * 32) so the row's flex shrinking always has a definite bound. `detail` and
   * `onClick` are optional; a click without a detail line is refused (the
   * footer must never promise an action it cannot explain on hover).
   *
   * Passing `undefined` (or text that sanitizes to nothing) CLEARS the field;
   * a stale disposer cannot clear a newer write for the same key.
   */
  setField(
    key: string,
    text: string | number | boolean | undefined,
    options?: TuiStatusFieldOptions,
    identity?: Context,
  ): () => void {
    const state = statusStateFor(this)
    assertCapabilityShadowPolicy('host.status.set', state.runtime.mode, state.runtime.slices)
    const noop = (): void => {}
    let caller: Context
    try {
      caller = requirePluginCaller(this.ctx, 'tuiStatus.setField', this)
    } catch {
      this.ctx.logger.warn('dsh-tui: tuiStatus.setField requires a live non-root plugin activation')
      return noop
    }
    const store = state.store
    // Capture the logger now: a click handler can outlive the activation, and
    // reaching back through a disposed caller proxy would only mask the error.
    const logger = caller.logger
    if (identity !== undefined) {
      try {
        assertCallerContext(caller, identity, 'tuiStatus.setField')
      } catch {
        logger.warn('dsh-tui: tuiStatus.setField rejected an identity belonging to another activation')
        return noop
      }
    }
    const owner = activationFiber(caller)
    if (owner === undefined) {
      logger.warn('dsh-tui: tuiStatus.setField requires a live activation owner')
      return noop
    }
    let normalized: string
    try {
      normalized = String(key ?? '').trim().toLowerCase()
    } catch {
      logger.warn('dsh-tui: tuiStatus.setField rejected an uncoercible key')
      return noop
    }
    if (!KEY_PATTERN.test(normalized)) {
      logger.warn('dsh-tui: tuiStatus.setField rejected an invalid key')
      return noop
    }
    const existing = store.fieldEntry(normalized)
    const ledger = caller.get('tuiEffectLedger')
    // Clear path. Ownership is checked BEFORE anything is removed: another
    // activation's field is not this caller's to clear.
    const clear = (): () => void => {
      if (existing === undefined) return noop
      if (existing.owner !== owner) {
        logger.warn(`dsh-tui: tuiStatus.setField rejected "${normalized}" — the field belongs to another activation`)
        return noop
      }
      if (store.clearFieldIf(normalized, existing.token, owner)) {
        ledger?.record(
          { operation: 'release', resource: { kind: 'status-field', id: normalized }, result: 'applied' },
          identity,
        )
      }
      return noop
    }
    if (text === undefined || text === '') return clear()
    // Scalar-only coercion, same rule as set(): an object must not become
    // "[object Object]" nor be silently downgraded to a clear.
    if (typeof text !== 'string' && typeof text !== 'number' && typeof text !== 'boolean') {
      logger.warn(`dsh-tui: tuiStatus.setField rejected non-scalar text for "${normalized}"`)
      return noop
    }
    let rawOptions: TuiStatusFieldOptions
    if (options === undefined) {
      rawOptions = {}
    } else if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      logger.warn(`dsh-tui: tuiStatus.setField rejected invalid options for "${normalized}"`)
      return noop
    } else {
      rawOptions = options
    }
    // The options object is plugin-supplied, so a throwing getter (or a Proxy)
    // must take the documented reject-and-warn path instead of escaping into
    // the caller. Read every option once, inside one guard: the checks below
    // then cannot re-trigger a getter.
    let optionMaxCells: number | undefined
    let optionSlot: TuiStatusFieldSlot | undefined
    let optionTone: TuiStatusFieldTone | undefined
    let optionMinColumns: number | undefined
    let optionDetail: string | undefined
    let optionOnClick: (() => void) | undefined
    try {
      optionMaxCells = rawOptions.maxCells
      optionSlot = rawOptions.slot
      optionTone = rawOptions.tone
      optionMinColumns = rawOptions.minColumns
      optionDetail = rawOptions.detail
      optionOnClick = rawOptions.onClick
    } catch {
      logger.warn(`dsh-tui: tuiStatus.setField rejected "${normalized}" — unreadable options`)
      return noop
    }
    const prev = existing?.entry
    let maxCells = prev?.maxCells ?? FIELD_CELLS_DEFAULT
    if (optionMaxCells !== undefined) {
      if (typeof optionMaxCells !== 'number' || !Number.isInteger(optionMaxCells)) {
        logger.warn(`dsh-tui: tuiStatus.setField rejected "${normalized}" — maxCells must be an integer`)
        return noop
      }
      maxCells = Math.min(FIELD_CELLS_MAX, Math.max(1, optionMaxCells))
    }
    const cleaned = cleanStatusFieldText(text, maxCells)
    // Whitespace/control/bidi-only text is a clear (set() folds it the same
    // way). Checked before the remaining option gates: a clear carries no
    // rendered options to validate.
    if (cleaned === '') return clear()
    let slot = prev?.slot ?? 'left-tail'
    if (optionSlot !== undefined) {
      if (!FIELD_SLOTS.has(optionSlot)) {
        logger.warn(`dsh-tui: tuiStatus.setField rejected "${normalized}" — invalid slot`)
        return noop
      }
      slot = optionSlot
    }
    let tone = prev?.tone ?? 'dim'
    if (optionTone !== undefined) {
      if (!FIELD_TONES.has(optionTone)) {
        logger.warn(`dsh-tui: tuiStatus.setField rejected "${normalized}" — invalid tone`)
        return noop
      }
      tone = optionTone
    }
    let minColumns = prev?.minColumns ?? 0
    if (optionMinColumns !== undefined) {
      if (typeof optionMinColumns !== 'number' || !Number.isInteger(optionMinColumns)) {
        logger.warn(`dsh-tui: tuiStatus.setField rejected "${normalized}" — minColumns must be an integer`)
        return noop
      }
      minColumns = Math.min(FIELD_MIN_COLUMNS_MAX, Math.max(0, optionMinColumns))
    }
    let detail = prev?.detail
    if (optionDetail !== undefined) {
      if (typeof optionDetail !== 'string') {
        logger.warn(`dsh-tui: tuiStatus.setField rejected "${normalized}" — detail must be a string`)
        return noop
      }
      // An explicitly empty/unsafe detail means "no detail", not "keep the old
      // one" — omitted is the only spelling that carries the previous value.
      detail = cleanStatusFieldText(optionDetail, FIELD_DETAIL_CELLS) || undefined
    }
    let rawOnClick = existing?.rawOnClick
    if (optionOnClick !== undefined) {
      if (typeof optionOnClick !== 'function') {
        logger.warn(`dsh-tui: tuiStatus.setField rejected "${normalized}" — onClick must be a function`)
        return noop
      }
      rawOnClick = optionOnClick
    }
    if (rawOnClick !== undefined && detail === undefined) {
      // D3: a clickable cell owes the user an explanation on hover.
      logger.warn(`dsh-tui: tuiStatus.setField rejected "${normalized}" — onClick requires detail`)
      return noop
    }
    if (existing === undefined) {
      if (store.fieldCount() >= MAX_FIELDS) {
        logger.warn(`dsh-tui: tuiStatus.setField rejected "${normalized}": ${MAX_FIELDS} footer fields already shown`)
        return noop
      }
      if (store.fieldsOwnedBy(owner) >= MAX_FIELDS_PER_OWNER) {
        logger.warn(`dsh-tui: tuiStatus.setField rejected "${normalized}": ${MAX_FIELDS_PER_OWNER} footer fields per plugin already shown`)
        return noop
      }
    } else if (existing.owner !== owner) {
      logger.warn(`dsh-tui: tuiStatus.setField rejected "${normalized}" — the field belongs to another activation`)
      return noop
    }
    // The wrapper lives HERE, not in the UI: a throwing click and a REJECTED
    // async click share one funnel — both are logged and reported as a toast.
    // A bare `rawOnClick()` leaves a returned promise unobserved, and an
    // unhandled rejection is fatal to the process guard; `shortcuts.ts` uses
    // the same deferred funnel for its handlers.
    const onClick = rawOnClick === undefined
      ? undefined
      : (): void => {
          Promise.resolve()
            .then(() => rawOnClick())
            .catch((error: unknown) => {
              const failure = error instanceof Error ? error : new Error(String(error))
              logger.warn(`dsh-tui: tuiStatus.setField "${normalized}" click failed: ${failure.message}`)
              store.reportFieldError(normalized, failure)
            })
        }
    const token = state.nextToken++
    const entry: TuiStatusFieldEntry = Object.freeze({
      key: normalized,
      text: cleaned,
      slot,
      tone,
      maxCells,
      minColumns,
      ...(detail === undefined ? {} : { detail }),
      ...(onClick === undefined ? {} : { onClick }),
    })
    store.setField(entry, token, owner, rawOnClick)
    const had = existing !== undefined
    let disposed = false
    let ledgerApplied = false
    let ownerCleanup: (() => unknown) | undefined
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      if (store.clearFieldIf(normalized, token, owner) && ledgerApplied) {
        caller.get('tuiEffectLedger')?.record(
          { operation: 'release', resource: { kind: 'status-field', id: normalized }, result: 'applied' },
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
    // bindCallerEffect runs the disposer itself when registration fails, so the
    // store entry is already rolled back here.
    if (!bound) return noop
    ledger?.record(
      {
        operation: had ? 'replace' : 'bind',
        resource: { kind: 'status-field', id: normalized },
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
    assertCapabilityShadowPolicy(
      'host.status.register-view',
      statusStateFor(this).runtime.mode,
      statusStateFor(this).runtime.slices,
    )
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

  /**
   * Subscribe to status-line changes. Kept on the plugin-visible service so
   * the shadow-policy gate covers this subscription effect too.
   */
  subscribe(listener: () => void): () => void {
    assertCapabilityShadowPolicy('host.status.subscribe', statusStateFor(this).runtime.mode, statusStateFor(this).runtime.slices)
    const caller = requirePluginCaller(this.ctx, 'tuiStatus.subscribe', this)
    const owner = activationFiber(caller)
    if (owner === undefined) return () => {}
    if (typeof listener !== 'function') return () => {}
    const wrapped = () => {
      try {
        listener()
      } catch (error) {
        caller.logger.warn(`dsh-tui: tuiStatus listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const dispose = statusStateFor(this).store.subscribe(wrapped)
    bindCallerEffect(caller, dispose)
    return dispose
  }
}

/** Host-only status store accessor; not part of the package export map. */
interface StatusState {
  readonly store: TuiStatusStore
  nextToken: number
  readonly runtime: AdapterRuntimeOptions
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
