/**
 * Plugin-facing composer context chips — the side-panel "Send to Chat"
 * staging (`ChannelUi.attachContext`, design §6.7) opened to host-side
 * plugins that own no panel. A plugin stages ONE keyed context; the composer
 * renders it as the usual `⧉ title` chip above the prompt, the NEXT
 * submission carries it as an `<attached-context source="plugin" …>` block
 * and clears it, and Esc peels it like any other chip. The plugin never sees
 * the draft and cannot submit: the user decides whether the chip is sent.
 *
 * Same split as the toast/status seams: a cordis-free sink container the
 * host bridges onto the channel's attached-context registry, plus a thin
 * cordis service that validates untrusted input, scopes the chip to the
 * calling activation, rate-limits it and checks the `context-chips.attach`
 * grant on every call.
 *
 * Identity: the host derives `sourceId = <plugin id>:<key>` (verified
 * Component id, else a session-only `session:actN`), so a plugin can neither
 * collide with nor replace another plugin's chip. Re-staging the same key
 * REPLACES the chip in place (same id and position) even when the title
 * changed — a selection that grew from 3 to 5 items is still one chip.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { cleanScalarText } from './sanitize.js'
import {
  activationFiber,
  bindCallerEffect,
  compositionRoot,
  concreteService,
  requirePluginCaller,
} from './host-access.js'
import { componentIdentityOf } from './component-identity.js'
import { getHostGrantStore } from './host-grants.js'
import { readGrantStore, type GrantStore } from '../adapter/standard/grants.js'
import {
  assertCapabilityShadowPolicy,
  type AdapterRuntimeOptions,
} from '../adapter/kernel/runtime.js'
import { adapterRuntimeFor } from '../adapter/kernel/runtime-context.js'
import type { AttachedContext } from '../adapter/ports/channel-view.js'

/** Plugin-facing input for {@link TuiContextChipsRuntime.attachContext}. */
export interface TuiContextChipInput {
  /** Plugin-local chip key: `^[a-z][a-z0-9_-]*$`, at most 64 characters. */
  readonly key: string
  /** Chip label; folded to one line and capped at 80 cells. */
  readonly title: string
  /** Model-facing body; capped at the shared mention limit when staged. */
  readonly content: string
}

/** One staged plugin context after validation, ready for the host sink. */
export interface TuiContextChipStaging {
  /** `<plugin id>:<key>`, derived by the host. */
  readonly sourceId: string
  readonly title: string
  readonly content: string
}

/** Host-side consumer; bridged onto the channel's attached-context registry
 *  by the TUI plugin row (see {@link createChannelContextChipsSink}). */
export interface TuiContextChipsSink {
  /** Stage (or replace) one plugin chip; false when nothing was staged. */
  attach(staging: TuiContextChipStaging): boolean
  /** Drop the plugin chip `sourceId`; false when none is staged. */
  detach(sourceId: string): boolean
  /** `sourceId`s of every plugin chip currently staged. */
  staged(): readonly string[]
}

/** Permission checked on every attach (default allow, revocable). */
export const CONTEXT_CHIPS_PERMISSION = 'context-chips.attach'

const KEY_PATTERN = /^[a-z][a-z0-9_-]*$/u
const KEY_MAX_CHARS = 64
const TITLE_CELLS = 80
// Four live chips per verified Component (or anonymous activation): the strip is one row tall, and a plugin
// filling it would push every panel's chip off the end.
const MAX_KEYS = 4
// Per-activation sliding window: a selection stream must not churn the
// composer faster than a person can read the chip.
const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = 20

/** Cordis-free sink container. The host registers the only sink; calls
 * before a sink exists (or after the TUI row unmounted) return false. */
export class TuiContextChipsStore {
  private sink: TuiContextChipsSink | undefined

  setSink(sink: TuiContextChipsSink | undefined): void {
    this.sink = sink
  }

  hasSink(): boolean {
    return this.sink !== undefined
  }

  /** Drop `sink` only if it is still the registered one: a re-mounted TUI
   *  row binds its own sink before the old mount's teardown runs. */
  clearSink(sink: TuiContextChipsSink): void {
    if (this.sink === sink) this.sink = undefined
  }

  attach(staging: TuiContextChipStaging): boolean {
    if (this.sink === undefined) return false
    try {
      return this.sink.attach(staging) === true
    } catch {
      return false
    }
  }

  detach(sourceId: string): boolean {
    if (this.sink === undefined) return false
    try {
      return this.sink.detach(sourceId) === true
    } catch {
      return false
    }
  }

  staged(): readonly string[] {
    if (this.sink === undefined) return []
    try {
      return this.sink.staged()
    } catch {
      return []
    }
  }
}

/**
 * The channel-side bridge: plugin chips ride the SAME registry as panel
 * chips, so the composer strip, Esc peeling, consume-once submission and the
 * session reset all apply unchanged. `writable` lets the host keep shadow
 * (observational) modes from mutating the composer.
 */
export function createChannelContextChipsSink(
  channel: {
    readonly attachedContexts: readonly AttachedContext[]
    attachContext(input: { source: 'panel' | 'plugin'; sourceId: string; title: string; content: string }): void
    detachContext(id: string): void
  },
  writable: () => boolean = () => true,
): TuiContextChipsSink {
  const pluginChip = (sourceId: string): AttachedContext | undefined =>
    (channel.attachedContexts ?? []).find(item => item.source === 'plugin' && item.sourceId === sourceId)
  return Object.freeze({
    attach(staging: TuiContextChipStaging): boolean {
      if (!writable()) return false
      channel.attachContext({ source: 'plugin', sourceId: staging.sourceId, title: staging.title, content: staging.content })
      return pluginChip(staging.sourceId) !== undefined
    },
    detach(sourceId: string): boolean {
      if (!writable()) return false
      const chip = pluginChip(sourceId)
      if (chip === undefined) return false
      channel.detachContext(chip.id)
      return true
    },
    staged(): readonly string[] {
      return (channel.attachedContexts ?? []).filter(item => item.source === 'plugin').map(item => item.sourceId)
    },
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiContextChips: TuiContextChipsRuntime
  }
}

interface ContextChipsState {
  readonly runtime: AdapterRuntimeOptions
  readonly store: TuiContextChipsStore
  readonly hostContext: Context
  readonly fallbackGrants: GrantStore
  /** Per-activation attach timestamps inside the sliding window. */
  readonly windows: WeakMap<object, number[]>
  /** Activations that already got their sticky rate-limit warning. */
  readonly warned: WeakSet<object>
  /** Per-activation chips with a registered dispose effect, by key. */
  readonly owned: WeakMap<object, Map<string, OwnedChip>>
  /** Latest activation for each shared Component/key sourceId. */
  readonly currentOwners: Map<string, { owner: object; entry: OwnedChip }>
}

/** The owner-effect handle for one staged key (see {@link releaseOwned}). */
interface OwnedChip {
  readonly sourceId: string
  /** Successful replacements, including ones by this same activation. */
  revision: number
  /** Removes the dispose effect from the caller's activation. */
  cleanup: (() => unknown) | undefined
}

/** Forget one key's dispose effect WITHOUT touching the composer. */
function releaseOwned(state: ContextChipsState, owned: Map<string, OwnedChip>, key: string): void {
  const entry = owned.get(key)
  if (entry === undefined) return
  owned.delete(key)
  if (state.currentOwners.get(entry.sourceId)?.entry === entry) state.currentOwners.delete(entry.sourceId)
  const cleanup = entry.cleanup
  entry.cleanup = undefined
  cleanup?.()
}

const hostContextChipsStates = new WeakMap<TuiContextChipsRuntime, ContextChipsState>()

/** Anonymous activation ids are session-only, never persistent identities
 *  (the same `session:actN` shape side panels fall back to). */
const fallbackPluginIds = new WeakMap<object, string>()
let fallbackSeq = 0

function pluginIdFor(caller: Context, owner: object): string {
  const identity = componentIdentityOf(caller)
  if (identity !== undefined && KEY_PATTERN.test(identity.componentId)) return identity.componentId
  let fallback = fallbackPluginIds.get(owner)
  if (fallback === undefined) {
    fallbackSeq += 1
    fallback = 'session:act' + String(fallbackSeq)
    fallbackPluginIds.set(owner, fallback)
  }
  return fallback
}

function normalizeKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.length <= KEY_MAX_CHARS && KEY_PATTERN.test(value) ? value : undefined
}

/** Grants: the plugin-host row's store when mounted, else a private read.
 *  Resolved per call, like the storage/observer seams. */
function grantsFor(state: ContextChipsState): GrantStore {
  return getHostGrantStore(state.hostContext.get('tuiPluginHost')) ?? state.fallbackGrants
}

/** Two-level checkpoint, the same shape as `commands.invoke`: `root` is the
 *  user's global switch; a verified Component is then checked under its own
 *  id. An anonymous activation has no id to revoke, so only `root` applies. */
function authorized(state: ContextChipsState, caller: Context): boolean {
  const grants = grantsFor(state)
  if (!grants.allows({ componentId: 'root' }, CONTEXT_CHIPS_PERMISSION, 'root')) return false
  const identity = componentIdentityOf(caller)
  if (identity === undefined) return true
  return grants.allows(
    { componentId: identity.componentId, activationId: identity.activationId },
    CONTEXT_CHIPS_PERMISSION,
    identity.componentId,
  )
}

/**
 * `ctx.tuiContextChips` — plugin-facing composer context chips. Invalid input,
 * over-limit callers, revoked grants and hosts without a bound chat channel
 * make the methods return `false` with a logger warning instead of
 * throwing: a chip must never take the TUI down.
 */
export class TuiContextChipsRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tuiContextChips')
    const hostContext = compositionRoot(ctx)
    const runtime = adapterRuntimeFor(ctx)
    const state: ContextChipsState = {
      runtime,
      store: new TuiContextChipsStore(),
      hostContext,
      fallbackGrants: readGrantStore(undefined, undefined, runtime),
      windows: new WeakMap(),
      warned: new WeakSet(),
      owned: new WeakMap(),
      currentOwners: new Map(),
    }
    hostContextChipsStates.set(this, state)
  }

  /**
   * Stage (or replace) this activation's chip for `key` on the chat
   * composer. Returns `true` when the chip is staged on the bound channel;
   * `false` when the input is invalid (bad key, non-string or empty
   * title/content), the Component already holds 4 other chips, the activation exceeded
   * 20 admitted attach attempts per sliding minute, `context-chips.attach`
   * is revoked, or no chat
   * channel is bound (headless/Web hosts never mount this service at all).
   * Input/grant/capacity refusals do not spend that budget. Delivery does,
   * even if its sink or a synchronous replacement makes this return false.
   */
  attachContext(input: TuiContextChipInput): boolean {
    assertCapabilityShadowPolicy('host.context-chips.attach', contextChipsStateFor(this).runtime.mode, contextChipsStateFor(this).runtime.slices)
    let caller: Context
    try {
      caller = requirePluginCaller(this.ctx, 'tuiContextChips.attachContext', this)
    } catch {
      this.ctx.logger.warn('dsh-tui: tuiContextChips.attachContext requires a live non-root plugin activation')
      return false
    }
    const state = contextChipsStateFor(this)
    let rawKey: unknown
    let rawTitle: unknown
    let rawContent: unknown
    try {
      rawKey = input.key
      rawTitle = input.title
      rawContent = input.content
    } catch {
      caller.logger.warn('dsh-tui: tuiContextChips.attachContext rejected unreadable input')
      return false
    }
    const key = normalizeKey(rawKey)
    if (key === undefined) {
      caller.logger.warn('dsh-tui: tuiContextChips.attachContext rejected an invalid key')
      return false
    }
    if (typeof rawTitle !== 'string' || typeof rawContent !== 'string') {
      caller.logger.warn(`dsh-tui: tuiContextChips.attachContext rejected "${key}": title and content must be strings`)
      return false
    }
    const title = cleanScalarText(rawTitle, TITLE_CELLS)
    if (title === '' || rawContent.trim() === '') {
      caller.logger.warn(`dsh-tui: tuiContextChips.attachContext rejected "${key}": empty title or content`)
      return false
    }
    const owner = activationFiber(caller)
    if (owner === undefined) {
      caller.logger.warn('dsh-tui: tuiContextChips.attachContext requires a live activation owner')
      return false
    }
    if (!authorized(state, caller)) {
      caller.logger.warn(`dsh-tui: tuiContextChips.attachContext refused "${key}" (${CONTEXT_CHIPS_PERMISSION} revoked in the grants file)`)
      caller.get('tuiEffectLedger')?.record(
        { operation: 'bind', resource: { kind: 'permission', id: CONTEXT_CHIPS_PERMISSION }, result: 'failed', errorCode: 'PERMISSION_NOT_GRANTED' },
        caller,
      )
      return false
    }
    const prefix = pluginIdFor(caller, owner) + ':'
    const sourceId = prefix + key
    const staged = state.store.staged()
    const replacing = staged.includes(sourceId)
    if (!replacing && staged.filter(id => id.startsWith(prefix)).length >= MAX_KEYS) {
      caller.logger.warn(`dsh-tui: tuiContextChips.attachContext rejected "${key}": ${MAX_KEYS} chips already staged by this plugin`)
      return false
    }
    const now = Date.now()
    const window = state.windows.get(owner) ?? []
    while (window.length > 0 && now - window[0]! >= RATE_WINDOW_MS) window.shift()
    if (window.length >= RATE_LIMIT) {
      if (!state.warned.has(owner)) {
        state.warned.add(owner)
        caller.logger.warn(`dsh-tui: tuiContextChips.attachContext rate-limited an activation to ${RATE_LIMIT}/min; further attaches in this window are dropped`)
      }
      state.windows.set(owner, window)
      return false
    }
    window.push(now)
    state.windows.set(owner, window)
    const previous = state.currentOwners.get(sourceId)
    const previousRevision = previous?.entry.revision
    if (!state.store.attach({ sourceId, title, content: rawContent })) return false
    // The sink emits synchronously: a subscriber may already have staged a
    // newer chip. Do not claim that replacement or retire its owner's effect.
    if (state.currentOwners.get(sourceId) !== previous || previous?.entry.revision !== previousRevision) return false
    const ledger = caller.get('tuiEffectLedger')
    // Replacing the same Component/key transfers ownership. Retire the old
    // activation's cleanup before binding the new one, without peeling the
    // replacement that the sink has just staged.
    if (previous !== undefined && previous.owner !== owner) {
      const previousKeys = state.owned.get(previous.owner)
      if (previousKeys !== undefined) releaseOwned(state, previousKeys, key)
    }
    let owned = state.owned.get(owner)
    if (owned === undefined) {
      owned = new Map()
      state.owned.set(owner, owned)
    }
    if (!owned.has(key)) {
      // Chips the user already sent or peeled with Esc no longer need a
      // dispose effect; prune them so the owner list stays bounded by the
      // live chips instead of every key the plugin ever used.
      const live = new Set(state.store.staged())
      for (const ownedKey of [...owned.keys()]) {
        if (!live.has(prefix + ownedKey)) releaseOwned(state, owned, ownedKey)
      }
      // One dispose effect per key: unloading the plugin peels every chip it
      // staged (a chip that is already gone makes it a no-op).
      const keys = owned
      const entry: OwnedChip = { sourceId, revision: 0, cleanup: undefined }
      const dispose = (): void => {
        if (keys.get(key) !== entry) return
        const current = state.currentOwners.get(sourceId)?.entry === entry
        releaseOwned(state, keys, key)
        if (current && state.store.detach(sourceId)) {
          ledger?.record({ operation: 'release', resource: { kind: 'context-chip', id: sourceId }, result: 'applied' }, caller)
        }
      }
      keys.set(key, entry)
      state.currentOwners.set(sourceId, { owner, entry })
      if (!bindCallerEffect(caller, dispose, cleanup => { entry.cleanup = cleanup })) return false
    }
    owned.get(key)!.revision += 1
    ledger?.record(
      {
        operation: replacing ? 'replace' : 'bind',
        resource: { kind: 'context-chip', id: sourceId },
        result: 'applied',
        ...(replacing ? { replaces: { resourceId: sourceId } } : {}),
      },
      caller,
    )
    return true
  }

  /**
   * Drop this activation's chip for `key`. Returns `false` for an invalid
   * key or when no such chip is staged (already sent, peeled with Esc, or
   * cleared by a session reset).
   */
  detachContext(key: string): boolean {
    assertCapabilityShadowPolicy('host.context-chips.detach', contextChipsStateFor(this).runtime.mode, contextChipsStateFor(this).runtime.slices)
    let caller: Context
    try {
      caller = requirePluginCaller(this.ctx, 'tuiContextChips.detachContext', this)
    } catch {
      this.ctx.logger.warn('dsh-tui: tuiContextChips.detachContext requires a live non-root plugin activation')
      return false
    }
    const state = contextChipsStateFor(this)
    const normalized = normalizeKey(key)
    if (normalized === undefined) {
      caller.logger.warn('dsh-tui: tuiContextChips.detachContext rejected an invalid key')
      return false
    }
    const owner = activationFiber(caller)
    if (owner === undefined) {
      caller.logger.warn('dsh-tui: tuiContextChips.detachContext requires a live activation owner')
      return false
    }
    const sourceId = pluginIdFor(caller, owner) + ':' + normalized
    // Release the owner effect first so its dispose can never run a second
    // detach for the same key.
    const owned = state.owned.get(owner)
    const entry = owned?.get(normalized)
    if (owned === undefined || entry === undefined || state.currentOwners.get(sourceId)?.entry !== entry) return false
    releaseOwned(state, owned, normalized)
    const removed = state.store.detach(sourceId)
    if (removed) {
      caller.get('tuiEffectLedger')?.record({ operation: 'release', resource: { kind: 'context-chip', id: sourceId }, result: 'applied' }, caller)
    }
    return removed
  }
}

function contextChipsStateFor(runtime: TuiContextChipsRuntime): ContextChipsState {
  const state = hostContextChipsStates.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiContextChips host store is unavailable')
  return state
}

/** Host-only context-chips store accessor; not part of the package export map. */
export function getHostContextChipsStore(runtime: TuiContextChipsRuntime | undefined): TuiContextChipsStore | undefined {
  if (runtime === undefined) return undefined
  try {
    return hostContextChipsStates.get(concreteService(runtime))?.store
  } catch {
    return undefined
  }
}

export default TuiContextChipsRuntime
