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
import { stringWidth } from '../ink/stringWidth.js'

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
}

/** Distributive Omit: `Omit` over a union collapses to the shared members
 *  only, which would strip kind-specific fields from the ask() input. */
type WithoutKey<T> = T extends unknown ? Omit<T, 'key'> : never

/** Render-path strings are untrusted: strip C0/C1 control chars, collapse
 *  whitespace, cap width. Width is terminal CELLS, not string.length. */
function cleanText(value: string, maxCells: number): string {
  // eslint-disable-next-line no-control-regex -- deliberate: sanitize untrusted render-path text
  const flat = value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (stringWidth(flat) <= maxCells) return flat
  let out = ''
  for (const ch of flat) {
    if (stringWidth(out + ch) > maxCells - 1) break
    out += ch
  }
  return `${out}…`
}

const TITLE_CELLS = 120
const LABEL_CELLS = 120
const MESSAGE_CELLS = 400
const INPUT_CELLS = 500
const MAX_OPTIONS = 100

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
      }
      pending.snapshot = { ...snapshot, key: pending.key } as TuiDialogSnapshot
      pending.settle = (value: TuiDialogAnswer): void => {
        if (settled) return
        settled = true
        if (pending.timer !== undefined) clearTimeout(pending.timer)
        signal?.removeEventListener('abort', pending.onAbort)
        resolve(value)
      }
      pending.onAbort = () => {
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
      this.queue.push(pending)
      this.advance()
    })
  }

  /** The dialog the UI should render right now, if any. */
  getSnapshot(): TuiDialogSnapshot | null {
    return this.active?.snapshot ?? null
  }

  /** Settle the active dialog with the user's answer (no-op when stale). */
  decide(value: TuiDialogAnswer): void {
    const pending = this.active
    if (pending === null) return
    this.active = null
    pending.settle(value)
    this.advance()
  }

  /** Cancel the active dialog (Esc). */
  cancel(): void {
    const pending = this.active
    if (pending === null) return
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
  /** The queue the chat screen renders. Exposed for the host, not plugins. */
  readonly store = new TuiDialogStore()

  constructor(ctx: Context) {
    super(ctx, 'tuiDialogs')
    ctx.effect(() => () => this.store.settleAll())
  }

  /** Pick one of `options`; resolves the option id, or undefined on cancel. */
  select(request: TuiDialogSelectRequest): Promise<string | undefined> {
    const title = cleanText(String(request?.title ?? ''), TITLE_CELLS)
    const rawOptions = Array.isArray(request?.options) ? request.options : []
    const options: TuiDialogSelectOption[] = []
    for (const raw of rawOptions.slice(0, MAX_OPTIONS)) {
      const id = cleanText(String(raw?.id ?? ''), LABEL_CELLS)
      const label = cleanText(String(raw?.label ?? ''), LABEL_CELLS)
      if (!id || !label) continue
      const description =
        raw?.description === undefined
          ? undefined
          : cleanText(String(raw.description), MESSAGE_CELLS)
      options.push({ id, label, ...(description === undefined ? {} : { description }) })
    }
    if (!title || options.length === 0) {
      this.ctx.logger.warn('dsh-tui: tuiDialogs.select called without a title or options; cancelled')
      return Promise.resolve(undefined)
    }
    return this.store
      .ask({ kind: 'select', title, options }, request.signal, request.timeoutMs)
      .then(value => (typeof value === 'string' ? value : undefined))
  }

  /** Yes/no question; resolves the boolean, false on cancel. */
  confirm(request: TuiDialogConfirmRequest): Promise<boolean> {
    const title = cleanText(String(request?.title ?? ''), TITLE_CELLS)
    if (!title) {
      this.ctx.logger.warn('dsh-tui: tuiDialogs.confirm called without a title; cancelled')
      return Promise.resolve(false)
    }
    const message =
      request.message === undefined ? undefined : cleanText(String(request.message), MESSAGE_CELLS)
    const confirmLabel = cleanText(String(request.confirmLabel ?? ''), LABEL_CELLS)
    const cancelLabel = cleanText(String(request.cancelLabel ?? ''), LABEL_CELLS)
    return this.store
      .ask(
        {
          kind: 'confirm',
          title,
          ...(message === undefined ? {} : { message }),
          confirmLabel,
          cancelLabel,
        },
        request.signal,
        request.timeoutMs,
      )
      .then(value => value === true)
  }

  /** Free-text input; resolves the text, or undefined on cancel. */
  input(request: TuiDialogInputRequest): Promise<string | undefined> {
    const title = cleanText(String(request?.title ?? ''), TITLE_CELLS)
    if (!title) {
      this.ctx.logger.warn('dsh-tui: tuiDialogs.input called without a title; cancelled')
      return Promise.resolve(undefined)
    }
    const placeholder =
      request.placeholder === undefined
        ? undefined
        : cleanText(String(request.placeholder), LABEL_CELLS)
    const initial = cleanText(String(request.initial ?? ''), INPUT_CELLS)
    return this.store
      .ask(
        { kind: 'input', title, ...(placeholder === undefined ? {} : { placeholder }), initial },
        request.signal,
        request.timeoutMs,
      )
      .then(value => (typeof value === 'string' ? value : undefined))
  }
}

export default TuiDialogRuntime
