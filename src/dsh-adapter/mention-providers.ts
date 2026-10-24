/**
 * Plugin `@`-mention providers (`ctx.tuiMentions`): optional plugins add rows
 * to the composer's `@` completion popup next to the workspace files — a
 * Blender bridge offering scene objects, an issue tracker offering tickets.
 *
 * The seam is completion-only. A chosen row replaces the typed `@query` with
 * the provider's plain `insertText`; nothing is resolved or attached at submit
 * time, so the file-mention expander never sees provider rows (an item whose
 * `insertText` would itself parse as an `@` mention is dropped at ingress).
 *
 * Same split as the command-tree seam: a host-only facade the composer
 * queries, plus a thin cordis service that validates untrusted registrations
 * and binds each provider to its caller's activation, so a disposed or
 * hot-reloaded plugin leaves no rows behind.
 *
 * Provider calls are untrusted and optional UI: every call gets its own
 * AbortSignal (aborted when the query moves on or the call times out), late
 * results are dropped, a throwing or rejecting provider contributes nothing,
 * and the failure goes to the opt-in `DSH_TUI_DEBUG` log, never the screen.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { ProvidedMentionCandidate } from '../adapter/ports/channel-catalog.js'
import { extractMentions } from '../utils/mentions.js'
import { logForDebugging } from '../utils/debug.js'
import { cleanStatusFieldText } from './sanitize.js'
import { activationFiber, bindCallerEffect, compositionRoot, concreteService, requirePluginCaller } from './host-access.js'
import { adapterRuntimeFor } from '../adapter/kernel/runtime-context.js'
import {
  assertCapabilityShadowPolicy,
  type AdapterRuntimeOptions,
} from '../adapter/kernel/runtime.js'

/** One completion row a provider offers for the current query. */
export interface TuiMentionItem {
  /** Row text; single line, at most 80 cells after sanitization. */
  readonly label: string
  /** Dim trailing hint (kind, location); at most 40 cells. */
  readonly detail?: string
  /**
   * Plain single-line text that replaces the typed `@query` (the host adds
   * the trailing space). At most 200 characters, and it must not contain an
   * `@` mention token of its own — such an item is dropped.
   */
  readonly insertText: string
}

/** A plugin's `@` completion source. */
export interface TuiMentionProvider {
  /** Unique provider id, `^[a-z][a-z0-9_-]*$`. */
  readonly id: string
  /** Shown beside every row this provider contributes; at most 40 cells. */
  readonly title: string
  /**
   * Rows for `query` (the text after `@`, possibly empty). `signal` aborts
   * when the user keeps typing or the call outlives its time budget; results
   * that arrive after that are ignored.
   */
  complete(query: string, signal: AbortSignal): readonly TuiMentionItem[] | Promise<readonly TuiMentionItem[]>
}

/** Admission and per-call bounds, exported so docs and the battery agree. */
export const MENTION_PROVIDER_LIMITS = Object.freeze({
  /** Providers one plugin activation may hold at once. */
  perActivation: 4,
  /** Providers the whole host holds at once. */
  total: 16,
  /** Rows taken from one provider per query. */
  itemsPerProvider: 50,
  /** Per-call budget; a slower provider contributes nothing for that query. */
  timeoutMs: 300,
  titleCells: 40,
  labelCells: 80,
  detailCells: 40,
  insertTextChars: 200,
})

const PROVIDER_ID = /^[a-z][a-z0-9_-]*$/u

/** Host-only access. Plugins see only `register` on the traceable service;
 * the composer queries every provider through this facade. */
export interface TuiMentionHost {
  register(provider: TuiMentionProvider): () => void
  /** Registered provider count; the composer skips the query at zero. */
  size(): number
  /** Every provider's rows for `query`, in registration order. */
  complete(query: string, signal: AbortSignal): Promise<readonly ProvidedMentionCandidate[]>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiMentions: TuiMentionRuntime
  }
}

export const name = 'dsh-tui-mentions'

interface ProviderEntry {
  readonly id: string
  readonly title: string
  readonly provider: TuiMentionProvider
  /** The registering activation; undefined for host-side (probe) entries. */
  readonly owner: object | undefined
}

interface MentionState {
  readonly runtime: AdapterRuntimeOptions
  readonly providers: Map<string, ProviderEntry>
  host: TuiMentionHost | undefined
}

const mentionStates = new WeakMap<TuiMentionRuntime, MentionState>()

/**
 * `ctx.tuiMentions` — plugin `@` completion providers. `register` throws on a
 * malformed provider, a duplicate id or an exhausted budget (registration is
 * a programming error, unlike a per-query failure, which only logs).
 */
export class TuiMentionRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tuiMentions')
    compositionRoot(ctx)
    const runtime = this
    const state: MentionState = { runtime: adapterRuntimeFor(ctx), providers: new Map(), host: undefined }
    state.host = Object.freeze({
      register: (provider: TuiMentionProvider) => {
        const state = mentionStateFor(runtime)
        const entry = admit(state, provider, undefined)
        state.providers.set(entry.id, entry)
        return () => release(state, entry)
      },
      size: () => mentionStateFor(runtime).providers.size,
      complete: (query: string, signal: AbortSignal) => completeAll(mentionStateFor(runtime), query, signal),
    })
    mentionStates.set(this, state)
  }

  register(provider: TuiMentionProvider): () => void {
    const state = mentionStateFor(this)
    assertCapabilityShadowPolicy('host.mentions.register', state.runtime.mode, state.runtime.slices)
    const caller = requirePluginCaller(this.ctx, 'tuiMentions.register', this)
    const owner = activationFiber(caller)
    if (owner === undefined) throw new Error('dsh-tui: tuiMentions.register requires a live activation')
    const entry = admit(state, provider, owner)
    state.providers.set(entry.id, entry)
    const dispose = () => release(state, entry)
    bindCallerEffect(caller, dispose)
    return dispose
  }
}

/** Validate one registration against shape and budgets; throws on refusal. */
function admit(state: MentionState, provider: TuiMentionProvider, owner: object | undefined): ProviderEntry {
  if (provider === null || typeof provider !== 'object') throw new TypeError('tuiMentions.register expects a provider object')
  const id = typeof provider.id === 'string' ? provider.id : ''
  if (!PROVIDER_ID.test(id)) throw new TypeError(`invalid TUI mention provider id: ${String(provider.id)}`)
  if (typeof provider.complete !== 'function') throw new TypeError(`TUI mention provider "${id}" needs a complete() function`)
  const title = cleanStatusFieldText(provider.title, MENTION_PROVIDER_LIMITS.titleCells)
  if (title === '') throw new TypeError(`TUI mention provider "${id}" needs a non-empty title`)
  if (state.providers.has(id)) throw new Error(`TUI mention provider "${id}" is already registered`)
  if (state.providers.size >= MENTION_PROVIDER_LIMITS.total) {
    throw new Error(`TUI mention providers are capped at ${MENTION_PROVIDER_LIMITS.total}; "${id}" was refused`)
  }
  if (owner !== undefined) {
    let held = 0
    for (const entry of state.providers.values()) if (entry.owner === owner) held += 1
    if (held >= MENTION_PROVIDER_LIMITS.perActivation) {
      throw new Error(`TUI mention providers are capped at ${MENTION_PROVIDER_LIMITS.perActivation} per plugin; "${id}" was refused`)
    }
  }
  return { id, title, provider, owner }
}

function release(state: MentionState, entry: ProviderEntry): void {
  if (state.providers.get(entry.id) === entry) state.providers.delete(entry.id)
}

async function completeAll(
  state: MentionState,
  query: string,
  signal: AbortSignal,
): Promise<readonly ProvidedMentionCandidate[]> {
  if (state.providers.size === 0 || signal.aborted) return []
  const settled = await Promise.all([...state.providers.values()].map(entry => completeOne(entry, query, signal)))
  return signal.aborted ? [] : settled.flat()
}

/** One provider call under its own signal and time budget. Never rejects. */
async function completeOne(
  entry: ProviderEntry,
  query: string,
  outer: AbortSignal,
): Promise<readonly ProvidedMentionCandidate[]> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  outer.addEventListener('abort', abort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<undefined>(resolve => {
      timer = setTimeout(() => {
        controller.abort()
        resolve(undefined)
      }, MENTION_PROVIDER_LIMITS.timeoutMs)
    })
    // `then` turns a synchronous throw into a rejection the catch below sees.
    const call = Promise.resolve().then(() => entry.provider.complete(query, controller.signal))
    const result = await Promise.race([call, timeout])
    if (controller.signal.aborted) {
      if (!outer.aborted) logForDebugging('tuiMentions provider timed out', { id: entry.id, timeoutMs: MENTION_PROVIDER_LIMITS.timeoutMs })
      return []
    }
    return normalizeItems(entry, result)
  } catch (error) {
    if (!controller.signal.aborted) {
      logForDebugging('tuiMentions provider failed', { id: entry.id, error: error instanceof Error ? error.message : String(error) })
    }
    return []
  } finally {
    clearTimeout(timer)
    outer.removeEventListener('abort', abort)
  }
}

/** Sanitize one provider's rows; malformed rows are skipped, not fatal. */
function normalizeItems(entry: ProviderEntry, result: unknown): readonly ProvidedMentionCandidate[] {
  if (!Array.isArray(result)) {
    logForDebugging('tuiMentions provider returned a non-array', { id: entry.id })
    return []
  }
  const out: ProvidedMentionCandidate[] = []
  const seen = new Set<string>()
  for (const raw of result.slice(0, MENTION_PROVIDER_LIMITS.itemsPerProvider) as unknown[]) {
    try {
      if (raw === null || typeof raw !== 'object') continue
      const item = raw as Partial<Record<keyof TuiMentionItem, unknown>>
      const label = cleanStatusFieldText(item.label, MENTION_PROVIDER_LIMITS.labelCells)
      const insertText = cleanStatusFieldText(item.insertText, Number.POSITIVE_INFINITY)
      if (label === '' || insertText === '') continue
      if (insertText.length > MENTION_PROVIDER_LIMITS.insertTextChars) continue
      if (extractMentions(insertText).length > 0) continue
      const detail = item.detail === undefined ? '' : cleanStatusFieldText(item.detail, MENTION_PROVIDER_LIMITS.detailCells)
      const id = `${entry.id}\u0000${label}\u0000${insertText}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({
        id,
        kind: 'provided',
        providerId: entry.id,
        section: entry.title,
        label,
        ...(detail === '' ? {} : { detail }),
        insertText,
      })
    } catch {
      // A throwing getter on one row must not cost the provider its others.
    }
  }
  return out
}

function mentionStateFor(runtime: TuiMentionRuntime): MentionState {
  const state = mentionStates.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiMentions host state is unavailable')
  return state
}

/** Host-only facade accessor; not part of the package export map. */
export function getHostMentions(runtime: TuiMentionRuntime | undefined): TuiMentionHost | undefined {
  if (runtime === undefined) return undefined
  try {
    return mentionStateFor(runtime).host
  } catch {
    return undefined
  }
}

export default TuiMentionRuntime
