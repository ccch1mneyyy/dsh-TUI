/**
 * Managed plugin dialogs — the pi `ctx.ui.select/confirm/input` seam for
 * dsh-TUI. Plugins hand the HOST a declarative request; the TUI renders the
 * dialog in its own chrome (next to the approval panel), owns the keyboard,
 * and settles the plugin's promise with the user's answer. Plugins never
 * touch the TTY themselves.
 *
 * Split in two, mirroring QuestionStore/ApprovalStore:
 *
 * - {@link TuiDialogStore} — cordis-free queue + snapshot. The chat screen
 *   subscribes to it and renders the current dialog; tests can drive it
 *   without a cordis context.
 * - {@link TuiDialogRuntime} — the cordis service (`ctx.tuiDialogs`)
 *   plugins call. Validation of untrusted request data lives here.
 *
 * Queue semantics mirror the approval store: parallel plugin calls park
 * FIFO and surface one at a time. A request settles exactly once — user
 * answer, Esc cancel, caller AbortSignal, caller timeout, or service
 * teardown (`cancelled` outcomes map to `undefined`/`false` returns).
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { cleanScalarText } from './sanitize.js'
import { activationContext, bindCallerEffect, compositionRoot, concreteService, requirePluginCaller } from './host-access.js'

/** Option of a select dialog. `id` is what the promise resolves with. */
export interface TuiDialogSelectOption {
  id: string
  label: string
  description?: string
}

/** What the chat screen renders while a dialog is pending. */
export type TuiDialogSnapshot =
  | {
      readonly key: string
      readonly kind: 'select'
      readonly title: string
      readonly options: readonly TuiDialogSelectOption[]
    }
  | {
      readonly key: string
      readonly kind: 'confirm'
      readonly title: string
      readonly message?: string
      readonly confirmLabel: string
      readonly cancelLabel: string
    }
  | {
      readonly key: string
      readonly kind: 'input'
      readonly title: string
      readonly placeholder?: string
      readonly initial: string
    }

/** Common request options. */
export interface TuiDialogBase {
  /** Dialog title (rendered bold). Control chars are stripped. */
  title: string
  /** Cancels the request when fired — the pi `signal` option. */
  signal?: AbortSignal
  /** Auto-cancel after this many ms. Guards against a wedged flow when no
   *  TUI consumer is present (headless embedders). */
  timeoutMs?: number
}

export interface TuiDialogSelectRequest extends TuiDialogBase {
  options: readonly TuiDialogSelectOption[]
}

export interface TuiDialogConfirmRequest extends TuiDialogBase {
  message?: string
  /** Empty/absent labels fall back to the host's localized defaults. */
  confirmLabel?: string
  cancelLabel?: string
}

export interface TuiDialogInputRequest extends TuiDialogBase {
  placeholder?: string
  initial?: string
}

/** Settled value of the active dialog: the select id, the confirm boolean,
 *  or the input text. `undefined` means cancelled. */
export type TuiDialogAnswer = string | boolean | undefined

interface PendingDialog {
  readonly key: string
  /** Assigned right after construction (the key is baked into it). */
  snapshot: TuiDialogSnapshot
  /** Idempotent settler: first call wins, clears timer + abort listener. */
  settle: (value: TuiDialogAnswer) => void
  /** AbortSignal/timeout callback: remove + settle cancelled + re-render. */
  onAbort: () => void
  timer: ReturnType<typeof setTimeout> | undefined
  ownerCleanup?: () => unknown
}

/** Distributive Omit: `Omit` over a union collapses to the shared members
 *  only, which would strip kind-specific fields from the ask() input. */
type WithoutKey<T> = T extends unknown ? Omit<T, 'key'> : never

/** Render-path strings are untrusted: sanitization (control-char stripping,
 *  cell-width caps, scalar-only coercion) lives in ./sanitize.js — the one
 *  implementation of the Track A contract. `clean` drops non-scalars to ''
 *  so callers take their refuse path instead of rendering "[object Object]". */
const clean = cleanScalarText

const TITLE_CELLS = 120
const LABEL_CELLS = 120
const MESSAGE_CELLS = 400
/** The documented bound of the resolved input text; the panel enforces it
 *  on every edit path (typing AND paste) so the promise never resolves with
 *  a larger value. */
export const INPUT_CELLS = 500
const MAX_OPTIONS = 100
/** Bound a request that omits both signal and timeout. */
export const DIALOG_DEFAULT_TIMEOUT_MS = 30_000

let nextDialogId = 1

/**
 * Cordis-free dialog queue. `ask` parks a request; the UI drains one at a
 * time via the snapshot and settles through {@link decide}/{@link cancel}.
 */
export class TuiDialogStore {
  private readonly listeners = new Set<() => void>()
  private readonly queue: PendingDialog[] = []
  private active: PendingDialog | null = null

  /** Park a request. The snapshot argument must already be sanitized. */
  ask(
    snapshot: WithoutKey<TuiDialogSnapshot>,
    signal?: AbortSignal,
    timeoutMs?: number,
    owner?: Context,
    bindOwnerEffect?: (
      disposer: () => unknown,
      onRegistered: (cleanup: () => unknown) => void,
    ) => boolean,
  ): Promise<TuiDialogAnswer> {
    if (signal?.aborted) return Promise.resolve(undefined)
    return new Promise<TuiDialogAnswer>((resolve) => {
      let settled = false
      const pending: PendingDialog = {
        // The key is stable per dialog (the panel remounts fresh per
        // request, like ApprovalSnapshot.key) and unique across the queue.
        key: `dlg-${nextDialogId++}`,
        snapshot: undefined as unknown as TuiDialogSnapshot,
        settle: () => {},
        onAbort: () => {},
        timer: undefined,
        ownerCleanup: undefined,
      }
      pending.snapshot = { ...snapshot, key: pending.key } as TuiDialogSnapshot
      pending.settle = (value: TuiDialogAnswer): void => {
        if (settled) return
        settled = true
        if (pending.timer !== undefined) clearTimeout(pending.timer)
        signal?.removeEventListener('abort', pending.onAbort)
        const ownerCleanup = pending.ownerCleanup
        pending.ownerCleanup = undefined
        ownerCleanup?.()
        resolve(value)
      }
      pending.onAbort = () => {
        // Normal completion also disposes the owner effect. The effect's
        // cleanup must not re-enter the abort path and advance the queue a
        // second time.
        if (settled) return
        // Aborted while queued: drop silently. Aborted while active: close
        // the dialog and advance the queue.
        const index = this.queue.indexOf(pending)
        if (index !== -1) this.queue.splice(index, 1)
        if (this.active === pending) this.active = null
        pending.settle(undefined)
        // Must advance (not just emit): with the active dialog gone, the
        // next queued request has to become active — otherwise its Promise
        // parks forever and the UI shows no dialog until an unrelated ask
        // happens to trigger advance.
        this.advance()
      }
      signal?.addEventListener('abort', pending.onAbort, { once: true })
      if (timeoutMs !== undefined && timeoutMs > 0) {
        pending.timer = setTimeout(pending.onAbort, timeoutMs)
      }
      if (owner !== undefined) {
        const bound = bindOwnerEffect?.(
          pending.onAbort,
          cleanup => { pending.ownerCleanup = cleanup },
        ) ?? false
        if (!bound) {
          // An inactive or untrusted activation must never leave an orphan in
          // the queue. The binder also rolls back partial owner state.
          pending.onAbort()
          return
        }
      }
      this.queue.push(pending)
      this.advance()
    })
  }

  /** The dialog the UI should render right now, if any. */
  getSnapshot(): TuiDialogSnapshot | null {
    return this.active?.snapshot ?? null
  }

  /**
   * Settle the active dialog with the user's answer. The caller passes the
   * key of the snapshot IT rendered; a mismatched key is a stale callback
   * and ignored. This is not paranoia: ConPTY can deliver one Enter as a
   * same-batch CR+LF pair, firing the old panel's handler twice before
   * React unmounts it — an unkeyed decide would settle the active dialog
   * AND the successor the first call just promoted (one Enter answering two
   * consecutive dialogs).
   */
  decide(key: string, value: TuiDialogAnswer): void {
    const pending = this.active
    if (pending === null || pending.key !== key) return
    this.active = null
    pending.settle(value)
    this.advance()
  }

  /** Cancel the active dialog (Esc). Keyed like {@link decide}: a stale
   *  panel's Esc must not close the successor it never rendered. */
  cancel(key: string): void {
    const pending = this.active
    if (pending === null || pending.key !== key) return
    this.active = null
    pending.settle(undefined)
    this.advance()
  }

  /** Settle everything queued + active (teardown): all resolve cancelled. */
  settleAll(): void {
    const pending = [...this.queue]
    this.queue.length = 0
    if (this.active !== null) pending.push(this.active)
    this.active = null
    for (const item of pending) item.settle(undefined)
    this.emit()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private advance(): void {
    if (this.active === null && this.queue.length > 0) {
      this.active = this.queue.shift() ?? null
    }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiDialogs: TuiDialogRuntime
  }
}

/**
 * `ctx.tuiDialogs` — plugin-facing managed dialogs. Every method validates
 * its request (untrusted data on the render path) and resolves with the
 * cancelled value (`undefined`/`false`) rather than throwing when the
 * request is malformed — a dialog must never take the plugin or the TUI
 * down; callers get a logger warning instead.
 */
export class TuiDialogRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tuiDialogs')
    compositionRoot(ctx)
    // Keep queue state off the service object. Cordis invokes public methods
    // through a caller-bound proxy, so JS `#private` fields are unsuitable
    // here; the module-local WeakMap preserves both encapsulation and proxy
    // compatibility.
    const store = new TuiDialogStore()
    hostDialogStores.set(this, store)
    ctx.effect(() => () => store.settleAll())
  }

  /** Cordis traceable services normally provide the caller through `this.ctx`;
   * the explicit overloads below make ownership unambiguous for embedders and
   * tests that retain the service instance directly. */
  private callContext(value: unknown): Context {
    const caller = requirePluginCaller(this.ctx, 'tuiDialogs', this)
    if (!Context.is(value)) return caller
    // An explicit owner is accepted only when it is the activation that made
    // the service call.  Otherwise a plugin could pass the root (or another
    // plugin's context) and leave an orphaned dialog alive after deactivation.
    const canonical = activationContext(value)
    if (canonical === undefined || activationContext(caller) !== canonical) {
      throw new Error('tuiDialogs owner context must be the calling activation')
    }
    return canonical
  }

  private timeoutOf(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.min(Math.floor(value), 24 * 60 * 60 * 1000)
      : DIALOG_DEFAULT_TIMEOUT_MS
  }

  /** Pick one of `options`; resolves the option id, or undefined on cancel. */
  select(request: TuiDialogSelectRequest): Promise<string | undefined>
  select(owner: Context, request: TuiDialogSelectRequest): Promise<string | undefined>
  select(ownerOrRequest: Context | TuiDialogSelectRequest, explicitRequest?: TuiDialogSelectRequest): Promise<string | undefined> {
    try {
      const owner = this.callContext(ownerOrRequest)
      const request = (explicitRequest ?? ownerOrRequest) as TuiDialogSelectRequest
      const title = clean(request?.title, TITLE_CELLS)
      const rawOptions = Array.isArray(request?.options) ? request.options : []
      const options: TuiDialogSelectOption[] = []
      for (const raw of rawOptions.slice(0, MAX_OPTIONS)) {
        // The id is NOT render-path data — it is the opaque token the promise
        // resolves with, matched by the plugin against its own options. Sanitizing
        // it (whitespace collapse, cell truncation) would hand back a DIFFERENT
        // string the plugin cannot look up; validate and keep it verbatim.
        const id = raw?.id
        const label = clean(raw?.label, LABEL_CELLS)
        if (typeof id !== 'string' || id === '' || !label) continue
        // '' (absent, blank, or a dropped non-scalar) means no description row.
        const description = clean(raw?.description, MESSAGE_CELLS)
        options.push({ id, label, ...(description === '' ? {} : { description }) })
      }
      if (!title || options.length === 0) {
        this.ctx.logger.warn('dsh-tui: tuiDialogs.select called without a title or options; cancelled')
        return Promise.resolve(undefined)
      }
      return dialogStoreFor(this)
        .ask(
          { kind: 'select', title, options },
          request.signal,
          this.timeoutOf(request.timeoutMs),
          owner,
          (disposer, onRegistered) => bindCallerEffect(owner, disposer, onRegistered),
        )
        .then(value => (typeof value === 'string' ? value : undefined))
    } catch {
      this.ctx.logger.warn('dsh-tui: tuiDialogs.select received malformed data; cancelled')
      return Promise.resolve(undefined)
    }
  }

  /** Yes/no question; resolves the boolean, false on cancel. */
  confirm(request: TuiDialogConfirmRequest): Promise<boolean>
  confirm(owner: Context, request: TuiDialogConfirmRequest): Promise<boolean>
  confirm(ownerOrRequest: Context | TuiDialogConfirmRequest, explicitRequest?: TuiDialogConfirmRequest): Promise<boolean> {
    try {
      const owner = this.callContext(ownerOrRequest)
      const request = (explicitRequest ?? ownerOrRequest) as TuiDialogConfirmRequest
      const title = clean(request?.title, TITLE_CELLS)
      if (!title) {
        this.ctx.logger.warn('dsh-tui: tuiDialogs.confirm called without a title; cancelled')
        return Promise.resolve(false)
      }
      const message = clean(request?.message, MESSAGE_CELLS)
      const confirmLabel = clean(request?.confirmLabel, LABEL_CELLS)
      const cancelLabel = clean(request?.cancelLabel, LABEL_CELLS)
      return dialogStoreFor(this)
        .ask(
          {
            kind: 'confirm',
            title,
            ...(message === '' ? {} : { message }),
            confirmLabel,
            cancelLabel,
          },
          request.signal,
          this.timeoutOf(request.timeoutMs),
          owner,
          (disposer, onRegistered) => bindCallerEffect(owner, disposer, onRegistered),
        )
        .then(value => value === true)
    } catch {
      this.ctx.logger.warn('dsh-tui: tuiDialogs.confirm received malformed data; cancelled')
      return Promise.resolve(false)
    }
  }

  /** Free-text input; resolves the text, or undefined on cancel. */
  input(request: TuiDialogInputRequest): Promise<string | undefined>
  input(owner: Context, request: TuiDialogInputRequest): Promise<string | undefined>
  input(ownerOrRequest: Context | TuiDialogInputRequest, explicitRequest?: TuiDialogInputRequest): Promise<string | undefined> {
    try {
      const owner = this.callContext(ownerOrRequest)
      const request = (explicitRequest ?? ownerOrRequest) as TuiDialogInputRequest
      const title = clean(request?.title, TITLE_CELLS)
      if (!title) {
        this.ctx.logger.warn('dsh-tui: tuiDialogs.input called without a title; cancelled')
        return Promise.resolve(undefined)
      }
      const placeholder = clean(request?.placeholder, LABEL_CELLS)
      const initial = clean(request?.initial, INPUT_CELLS)
      return dialogStoreFor(this)
        .ask(
          { kind: 'input', title, ...(placeholder === '' ? {} : { placeholder }), initial },
          request.signal,
          this.timeoutOf(request.timeoutMs),
          owner,
          (disposer, onRegistered) => bindCallerEffect(owner, disposer, onRegistered),
        )
        .then(value => (typeof value === 'string' ? value : undefined))
    } catch {
      this.ctx.logger.warn('dsh-tui: tuiDialogs.input received malformed data; cancelled')
      return Promise.resolve(undefined)
    }
  }
}

/**
 * Host-only queue accessor. This module is intentionally not a package
 * export; plugins receive only the traceable `tuiDialogs` capability, whose
 * public surface is select/confirm/input.
 */
const hostDialogStores = new WeakMap<TuiDialogRuntime, TuiDialogStore>()

function dialogStoreFor(runtime: TuiDialogRuntime): TuiDialogStore {
  const store = hostDialogStores.get(concreteService(runtime))
  if (store === undefined) throw new Error('tuiDialogs host store is unavailable')
  return store
}

export function getHostDialogStore(runtime: TuiDialogRuntime | undefined): TuiDialogStore | undefined {
  if (runtime === undefined) return undefined
  try {
    return hostDialogStores.get(concreteService(runtime))
  } catch {
    return undefined
  }
}

export default TuiDialogRuntime
