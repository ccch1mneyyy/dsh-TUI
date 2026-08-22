/** Provider-neutral full-screen scene registry for the imperative pi-tui front door. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Component } from '../tui/public.js'
import type { TuiCommands } from '../tui/commands.js'
import type { ChatViewModel } from '../tui/view-model.js'
import { activationFiber, bindCallerEffect, compositionRoot, concreteService, requirePluginCaller } from './host-access.js'
import { componentIdentityOf } from './component-identity.js'

/** The only scene descriptor version accepted by dsh-TUI 0.9.0. */
export const TUI_SCENE_VERSION = 'dsh-tui/pi-tui-scene@1' as const
export type TuiSceneVersion = typeof TUI_SCENE_VERSION

/** Host-issued description of the one root layer owned by the TUI. */
export interface TuiSceneRootDescriptor {
  readonly kind: 'root'
  readonly id: string
  readonly mode: 'inline' | 'fullscreen'
}

/** Host-issued description of the overlay layer on the same TUI root. */
export interface TuiSceneOverlayDescriptor {
  readonly kind: 'overlay'
  readonly id: string
  readonly visible: boolean
}

/**
 * Context passed to an imperative scene factory.
 *
 * The view model is a bounded readonly projection, commands are the typed sink,
 * and root/overlay are opaque descriptions of layers already owned by the
 * single host TUI. A scene never receives a Channel, Cordis Context, React,
 * ui-kit, Terminal, or stdout handle.
 */
export interface TuiSceneContext {
  readonly viewModel: ChatViewModel
  readonly commands: TuiCommands
  readonly root: TuiSceneRootDescriptor
  readonly overlay: TuiSceneOverlayDescriptor
  readonly signal: AbortSignal
}

/** Versioned imperative scene descriptor. */
export interface TuiSceneDescriptor {
  readonly version: TuiSceneVersion
  readonly id: string
  readonly title?: string
  create(context: TuiSceneContext): Component
}

/** Host-only scene controls used by the TUI; omitted from the plugin export. */
export interface TuiSceneHost {
  readonly active: TuiSceneDescriptor | undefined
  open(id: string): boolean
  close(): void
  subscribe(listener: () => void): () => void
  /**
   * Create the active scene through the host-owned factory boundary. A factory
   * or shape failure closes the scene, reports through the typed notification
   * sink, and returns undefined; it never leaves a half-created active scene.
   */
  create(context: TuiSceneContext): Component | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiScenes: TuiSceneRuntime
  }
}

export const name = 'dsh-tui-scenes'

/**
 * Small host-only registry; command execution remains owned by dsh-commands.
 *
 * A plugin registers a scene once (`ctx.tuiScenes.register(...)`, keep the
 * dispose) and opens it from its own command handler with
 * `ctx.tuiScenes.open('my-scene')`. The control plane does not create a TUI or
 * terminal; the host later calls the host-only `create(context)` bridge.
 */
export class TuiSceneRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tuiScenes')
    compositionRoot(ctx)
    const runtime = this
    const state: SceneState = {
      scenes: new Map(),
      owners: new Map(),
      listeners: new Set(),
      current: undefined,
      host: undefined,
      activeToken: undefined,
      logger: ctx.logger,
    }
    state.host = Object.freeze({
      get active() {
        return sceneStateFor(runtime).current
      },
      open(id: string) {
        return openScene(runtime, id)
      },
      close() {
        closeScene(runtime)
      },
      subscribe(listener: () => void) {
        return subscribeScenes(runtime, listener)
      },
      create(context: TuiSceneContext) {
        return createScene(runtime, context)
      },
    })
    sceneStates.set(this, state)
  }

  /**
   * Register an imperative pi-tui scene. The optional trailing `identity` (the
   * plugin's own ctx) only feeds the effect ledger's pluginId — omitting it
   * records `undeclared` (C-060).
   *
   * Legacy React descriptors and descriptors without the exact version are
   * rejected with an explicit error. There is no compatibility fallback.
   */
  register(descriptor: TuiSceneDescriptor, identity?: Context): () => void {
    const state = sceneStateFor(this)
    const caller = requirePluginCaller(this.ctx, 'tuiScenes.register', this)
    const activationOwner = activationFiber(caller)
    if (activationOwner === undefined) throw new Error('dsh-tui: tuiScenes.register requires a live activation')
    const callerIdentity = componentIdentityOf(caller)
    const suppliedIdentity = identity === undefined ? callerIdentity : componentIdentityOf(identity)
    if (identity !== undefined && callerIdentity !== undefined && suppliedIdentity !== callerIdentity) {
      throw new Error('dsh-tui: tuiScenes.register identity belongs to another activation')
    }

    let normalized: TuiSceneDescriptor
    try {
      normalized = normalizeSceneDescriptor(descriptor)
    } catch (error) {
      caller.get('tuiEffectLedger')?.record(
        {
          operation: 'create',
          resource: { kind: 'scene', id: ledgerSceneId(descriptor) },
          result: 'failed',
          errorCode: sceneRegistrationErrorCode(error),
        },
        identity,
      )
      throw error
    }

    const id = normalized.id
    if (state.scenes.has(id)) {
      caller.get('tuiEffectLedger')?.record(
        {
          operation: 'create',
          resource: { kind: 'scene', id },
          result: 'failed',
          errorCode: 'DUPLICATE_CONTRIBUTION_ID',
        },
        identity,
      )
      throw new Error(`TUI scene "${id}" is already registered`)
    }
    state.scenes.set(id, normalized)
    state.owners.set(id, activationOwner)
    caller.get('tuiEffectLedger')?.record(
      { operation: 'create', resource: { kind: 'scene', id }, result: 'applied' },
      identity,
    )
    const dispose = () => {
      if (state.scenes.get(id) !== normalized) return
      state.scenes.delete(id)
      state.owners.delete(id)
      caller.get('tuiEffectLedger')?.record(
        { operation: 'release', resource: { kind: 'scene', id }, result: 'applied' },
        identity,
      )
      // Disposing the open scene must not strand the user on a dead screen.
      if (state.current === normalized) {
        state.current = undefined
        state.activeToken = undefined
        notifyScenes(state, activationOwner)
      }
    }
    bindCallerEffect(caller, dispose)
    return dispose
  }

  /**
   * Swap the conversation for the named scene. Returns false (and warns)
   * when no plugin registered that id — a mistyped id must fail visibly in the
   * log, not silently do nothing in the UI.
   */
  open(id: string): boolean {
    const caller = requirePluginCaller(this.ctx, 'tuiScenes.open', this)
    const owner = activationFiber(caller)
    return owner === undefined ? false : openScene(this, id, caller, owner)
  }

  close(): void {
    const caller = requirePluginCaller(this.ctx, 'tuiScenes.close', this)
    const owner = activationFiber(caller)
    if (owner !== undefined) closeScene(this, caller, owner)
  }

  /** The scene currently replacing the conversation, if any. */
  get active(): TuiSceneDescriptor | undefined {
    const caller = requirePluginCaller(this.ctx, 'tuiScenes.active', this)
    const owner = activationFiber(caller)
    const state = sceneStateFor(this)
    return owner !== undefined && state.current !== undefined && state.owners.get(state.current.id) === owner
      ? state.current
      : undefined
  }

  /** UI-side change feed: fired after every open/close/dispose transition. */
  subscribe(listener: () => void): () => void {
    const caller = requirePluginCaller(this.ctx, 'tuiScenes.subscribe', this)
    const owner = activationFiber(caller)
    if (owner === undefined) return () => {}
    const dispose = subscribeScenes(this, listener, owner)
    bindCallerEffect(caller, dispose)
    return dispose
  }
}

interface SceneState {
  readonly scenes: Map<string, TuiSceneDescriptor>
  readonly owners: Map<string, object>
  readonly listeners: Set<{ owner: object | undefined; listener: () => void }>
  current: TuiSceneDescriptor | undefined
  host: TuiSceneHost | undefined
  activeToken: object | undefined
  readonly logger: Context['logger']
}

const sceneStates = new WeakMap<TuiSceneRuntime, SceneState>()

const SCENE_ID_PATTERN = /^[a-z][a-z0-9_-]*$/u

function sceneStateFor(runtime: TuiSceneRuntime): SceneState {
  const state = sceneStates.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiScenes host state is unavailable')
  return state
}

function normalizeSceneDescriptor(descriptor: unknown): TuiSceneDescriptor {
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new TypeError('dsh-tui: TUI scene descriptor must be an object')
  }
  const raw = descriptor as Record<string, unknown>
  // Check this before version so the migration error is unambiguous for the
  // old `{ id, component }` shape, even though it is also missing `version`.
  if ('component' in raw) {
    throw new TypeError(
      `dsh-tui: legacy React scene descriptor "component" is unsupported; ` +
      `migrate to version "${TUI_SCENE_VERSION}" with create(context)`,
    )
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'version')) {
    throw new TypeError(
      `dsh-tui: TUI scene descriptor is missing version; expected "${TUI_SCENE_VERSION}"`,
    )
  }
  if (raw.version !== TUI_SCENE_VERSION) {
    throw new TypeError(
      `dsh-tui: unsupported TUI scene version ${String(raw.version)}; expected "${TUI_SCENE_VERSION}"`,
    )
  }
  if (typeof raw.id !== 'string') {
    throw new TypeError(`dsh-tui: invalid TUI scene id: ${String(raw.id)}`)
  }
  const id = raw.id.trim().toLowerCase()
  if (!SCENE_ID_PATTERN.test(id)) throw new TypeError(`invalid TUI scene id: ${raw.id}`)
  if (raw.title !== undefined && typeof raw.title !== 'string') {
    throw new TypeError(`dsh-tui: TUI scene "${id}" title must be a string`)
  }
  if (typeof raw.create !== 'function') {
    throw new TypeError(
      `dsh-tui: TUI scene "${id}" must provide create(context); ` +
      `legacy component descriptors are not supported`,
    )
  }
  return Object.freeze({
    version: TUI_SCENE_VERSION,
    id,
    ...(raw.title === undefined ? {} : { title: raw.title as string }),
    create: raw.create as TuiSceneDescriptor['create'],
  })
}

function ledgerSceneId(descriptor: unknown): string {
  try {
    const id = (descriptor as { id?: unknown } | null | undefined)?.id
    if (typeof id !== 'string') return 'unregistered'
    const normalized = id.trim().toLowerCase()
    return SCENE_ID_PATTERN.test(normalized) ? normalized : 'unregistered'
  } catch {
    return 'unregistered'
  }
}

function sceneRegistrationErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('version') || message.includes('legacy React')
    ? 'UNSUPPORTED_SCENE_API'
    : 'INVALID_SCENE_DESCRIPTOR'
}

function openScene(runtime: TuiSceneRuntime, id: string, caller?: Context, owner?: object): boolean {
  const state = sceneStateFor(runtime)
  const scene = state.scenes.get(id.trim().toLowerCase())
  if (scene === undefined) {
    ;(caller?.logger ?? state.logger).warn(`dsh-tui: no TUI scene registered as "${id}"`)
    return false
  }
  if (owner !== undefined && state.owners.get(scene.id) !== owner) {
    caller?.logger.warn(`dsh-tui: scene "${scene.id}" belongs to another activation`)
    return false
  }
  if (scene === state.current) return true
  const previousOwner = state.current === undefined ? undefined : state.owners.get(state.current.id)
  state.current = scene
  state.activeToken = {}
  notifyScenes(state, previousOwner)
  return true
}

function closeScene(runtime: TuiSceneRuntime, caller?: Context, owner?: object): void {
  const state = sceneStateFor(runtime)
  if (state.current === undefined) return
  if (owner !== undefined && state.owners.get(state.current.id) !== owner) {
    caller?.logger.warn(`dsh-tui: scene "${state.current.id}" belongs to another activation`)
    return
  }
  const previousOwner = state.owners.get(state.current.id)
  state.current = undefined
  state.activeToken = undefined
  notifyScenes(state, previousOwner)
}

function subscribeScenes(runtime: TuiSceneRuntime, listener: () => void, owner?: object): () => void {
  const state = sceneStateFor(runtime)
  const entry = { owner, listener }
  state.listeners.add(entry)
  return () => {
    state.listeners.delete(entry)
  }
}

function notifyScenes(state: SceneState, previousOwner?: object): void {
  const currentOwner = state.current === undefined ? undefined : state.owners.get(state.current.id)
  for (const entry of [...state.listeners]) {
    if (entry.owner !== undefined && entry.owner !== currentOwner && entry.owner !== previousOwner) continue
    try {
      entry.listener()
    } catch (error) {
      state.logger.warn(`dsh-tui: tuiScenes subscriber threw: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function isSceneComponent(value: unknown): value is Component {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<Component>
  return typeof candidate.render === 'function' && typeof candidate.invalidate === 'function'
}

function createScene(runtime: TuiSceneRuntime, context: TuiSceneContext): Component | undefined {
  const state = sceneStateFor(runtime)
  const scene = state.current
  const activeToken = state.activeToken
  if (scene === undefined || activeToken === undefined) return undefined

  try {
    const candidate = scene.create(Object.freeze({ ...context }))
    if (!isSceneComponent(candidate)) {
      throw new TypeError(
        `dsh-tui: TUI scene "${scene.id}" create(context) must return a pi-tui Component`,
      )
    }
    // A factory may synchronously close/reopen through the command sink. Do not
    // let the component from the stale factory escape into the newly active
    // scene's root.
    return state.current === scene && state.activeToken === activeToken ? candidate : undefined
  } catch (error) {
    if (state.current === scene && state.activeToken === activeToken) closeScene(runtime)
    notifySceneCreateFailure(scene.id, context, error, state.logger)
    return undefined
  }
}

function notifySceneCreateFailure(
  id: string,
  context: TuiSceneContext,
  error: unknown,
  logger: Context['logger'],
): void {
  const message = `dsh-tui: TUI scene "${id}" failed to create: ${error instanceof Error ? error.message : String(error)}`
  try {
    context.commands.info.notify(message, { color: 'error' })
  } catch {
    logger.warn(`${message} (notification sink unavailable)`)
  }
}

export function getHostSceneRuntime(runtime: TuiSceneRuntime | undefined): TuiSceneHost | undefined {
  if (runtime === undefined) return undefined
  try {
    return sceneStateFor(runtime).host ?? undefined
  } catch {
    return undefined
  }
}

export default TuiSceneRuntime
