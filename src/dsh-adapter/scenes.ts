/** Provider-neutral full-screen scene registry for terminal front doors. */

import type React from 'react'
import { Context, Service } from '@deepseek-ai/cordis'
import type { ChannelUi as Channel } from '../adapter/channel/ui-policy.js'
import { activationFiber, assertCallerContext, bindCallerEffect, compositionRoot, concreteService, requirePluginCaller } from './host-access.js'
import {
  assertCapabilityShadowPolicy,
  type AdapterRuntimeOptions,
} from '../adapter/kernel/runtime.js'
import { adapterRuntimeFor } from '../adapter/kernel/runtime-context.js'
import type { TuiPanelSnapshot } from './panels.js'
import type { TuiPluginStorage } from './plugin-storage.js'
import {
  clearSurfaceParams,
  freezeSurfaceParams,
  sceneParamsKey,
  setSurfaceParams,
  type SurfaceFileRequest,
  type TuiJsonValue,
  type TuiSurfaceHostApi,
} from './surface-host.js'

export type { TuiJsonValue, TuiSurfaceHostApi, TuiSurfaceOpenFileOptions } from './surface-host.js'

/**
 * The host API a scene receives (experimental; additive to the props below).
 * The navigation verbs are the same set side panels get; `snapshot()` is the
 * curated panel snapshot (with `usage`), `storage` the plugin's own
 * tuiPluginStorage handle. `openFile` keeps the calling scene as the screen
 * to return to: closing the preview lands back on it (remounted — scene
 * state that must survive belongs in params or storage).
 */
export interface TuiSceneHostApi extends TuiSurfaceHostApi {
  snapshot(): TuiPanelSnapshot
  readonly storage: TuiPluginStorage | undefined
}

/**
 * Props every plugin scene receives. Both element creation and hooks must go
 * through the HOST's React, never the plugin's own copy:
 *
 * - Hooks: a component rendered by this TUI's reconciler but calling hooks
 *   imported from a second React copy (the plugin's own node_modules) dies
 *   with an invalid-hook-call on first render. Use the injected `React`.
 * - Elements: this app's reconciler (React 19) accepts only
 *   `Symbol.for('react.transitional.element')` elements. JSX compiled
 *   against a plugin-bundled older React emits `Symbol.for('react.element')`
 *   and throws on first render. Create elements with the injected `React`
 *   (`React.createElement`/`React.Fragment`), or compile JSX against the
 *   host runtime via tsconfig
 *   `"jsxImportSource": "@deepseek-harness-tui/dsh-tui"` (its `./jsx-runtime`
 *   subpath re-exports this app's own react/jsx-runtime). A plugin-owned
 *   React copy works ONLY if it is the same React 19 line — and its hooks
 *   remain off-limits regardless.
 */
/**
 * A scene's `ui`: the `src/ui.ts` facade (scenes have always received the
 * whole module) plus the panel kit's narrowed `Markdown` / `CodeBlock`
 * wrappers, so one plugin view renders rich text the same way in a side panel
 * and in a scene. Additive: every member the module had is still there.
 */
export type TuiSceneUi = typeof import('../ui.js') & {
  readonly Markdown: React.ComponentType<import('./panels.js').TuiPanelMarkdownProps>
  readonly CodeBlock: React.ComponentType<import('./panels.js').TuiPanelCodeBlockProps>
}

export interface TuiSceneProps {
  /** The TUI's React instance — use THIS for every hook and element. */
  React: typeof React
  /** The TUI's ui kit (Box/Text/useInput/useTerminalSize/…, the chart kit),
   *  plus the same narrowed `Markdown`/`CodeBlock` side panels get. */
  ui: TuiSceneUi
  /** Live session channel: rows, status, trace events, notifications. */
  channel: Channel
  /** Leave the scene and return to whatever screen was up before. */
  close(): void
  /** Shared surface verbs + snapshot/storage (experimental). */
  host: TuiSceneHostApi
}

export interface TuiSceneDescriptor {
  /** Unique scene id (kebab-case); the plugin's own commands open it by id. */
  id: string
  /** Optional human label for logs/debugging; the scene renders its own header. */
  title?: string
  component: React.ComponentType<TuiSceneProps>
}

/** Host-only scene controls used by the channel; omitted from the plugin export. */
export interface TuiSceneHost {
  readonly active: TuiSceneDescriptor | undefined
  register(descriptor: TuiSceneDescriptor): () => void
  list(): readonly TuiSceneDescriptor[]
  open(id: string, params?: TuiJsonValue): boolean
  close(): void
  subscribe(listener: () => void): () => void
}

/**
 * The host-owned read-only file preview (`host.openFile`). Its id carries a
 * `:` so no plugin registration (`/^[a-z][a-z0-9_-]*$/`) can ever claim it,
 * and it is never listed: it is not a plugin contribution. The scene outlet
 * resolves the component (`channel-scene-outlet.ts`); the registry only
 * tracks it as the current screen.
 */
export const HOST_FILE_PREVIEW_SCENE_ID = 'dsh-tui:file-preview'

/** Each registry gets its own preview descriptor, so the preview's params
 *  belong to that composition (see {@link sceneParamsKeyOf}). */
function hostFilePreviewDescriptor(): TuiSceneDescriptor {
  return Object.freeze({
    id: HOST_FILE_PREVIEW_SCENE_ID,
    title: 'File preview',
    component: () => null,
  })
}

/** Who registered a plugin scene: what the rendered scene's host API acts as. */
export interface SceneOwnerRecord {
  readonly caller: Context
  readonly owner: object
  storage?: TuiPluginStorage
}

const sceneOwnerRecords = new WeakMap<TuiSceneDescriptor, SceneOwnerRecord>()

/** The registering activation of a scene descriptor; undefined for host scenes,
 *  host-facade registrations (they have no plugin identity to act as) and a
 *  registration that was disposed (its host verbs refuse from then on). */
export function sceneOwnerRecordOf(scene: TuiSceneDescriptor): SceneOwnerRecord | undefined {
  return sceneOwnerRecords.get(scene)
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
 * dispose) and opens it from anywhere host-side — typically its own
 * dsh-commands handler: `ctx.tuiScenes.open('my-scene')` plus a silent
 * `success` result, so the conversation stays untouched while the scene
 * takes the whole terminal the way the trajectory scene does.
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
      returnTo: undefined,
      filePreview: hostFilePreviewDescriptor(),
      host: undefined,
      logger: ctx.logger,
      runtime: adapterRuntimeFor(ctx),
    }
    state.host = Object.freeze({
      get active() {
        return sceneStateFor(runtime).current
      },
      register(descriptor: TuiSceneDescriptor) {
        const state = sceneStateFor(runtime)
        const id = descriptor.id.trim().toLowerCase()
        if (!/^[a-z][a-z0-9_-]*$/u.test(id)) throw new TypeError(`invalid TUI scene id: ${descriptor.id}`)
        if (state.scenes.has(id)) throw new Error(`TUI scene "${id}" is already registered`)
        const normalized = Object.freeze({ ...descriptor, id })
        state.scenes.set(id, normalized)
        sceneScopes.set(normalized, state)
        return () => {
          if (state.scenes.get(id) !== normalized) return
          state.scenes.delete(id)
          state.owners.delete(id)
          clearSurfaceParams(sceneParamsKey(state, id))
          if (state.returnTo === normalized) state.returnTo = undefined
          if (state.current === normalized) {
            state.current = undefined
            notifyScenes(state)
          }
        }
      },
      list() {
        return [...sceneStateFor(runtime).scenes.values()]
      },
      open(id: string, params?: TuiJsonValue) {
        return openScene(runtime, id, undefined, undefined, params)
      },
      close() {
        closeScene(runtime)
      },
      subscribe(listener: () => void) {
        return subscribeScenes(runtime, listener)
      },
    })
    sceneStates.set(this, state)
    sceneScopes.set(state.filePreview, state)
  }

  /**
   * Register a full-screen scene; returns the dispose function (caller
   * scopes it with `ctx.effect`). The optional trailing `identity` (the
   * plugin's own ctx) only feeds the effect ledger's pluginId — omitting it
   * records `undeclared` (C-060).
   */
  register(descriptor: TuiSceneDescriptor, identity?: Context): () => void {
    assertCapabilityShadowPolicy('host.scenes.register', sceneStateFor(this).runtime.mode, sceneStateFor(this).runtime.slices)
    const state = sceneStateFor(this)
    const caller = requirePluginCaller(this.ctx, 'tuiScenes.register', this)
    const activationOwner = activationFiber(caller)
    if (activationOwner === undefined) throw new Error('dsh-tui: tuiScenes.register requires a live activation')
    // Same rule as every other `identity`-taking registration: the caller's
    // own ctx, or an ancestor it acts under (a nested `ctx.inject` passing
    // its plugin's ctx). Anything else belongs to another activation.
    if (identity !== undefined) {
      try {
        assertCallerContext(caller, identity, 'tuiScenes.register', this)
      } catch {
        throw new Error('dsh-tui: tuiScenes.register identity belongs to another activation')
      }
    }
    const id = descriptor.id.trim().toLowerCase()
    if (!/^[a-z][a-z0-9_-]*$/u.test(id)) throw new TypeError(`invalid TUI scene id: ${descriptor.id}`)
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
    const normalized = Object.freeze({ ...descriptor, id })
    state.scenes.set(id, normalized)
    sceneScopes.set(normalized, state)
    state.owners.set(id, activationOwner)
    sceneOwnerRecords.set(normalized, { caller, owner: activationOwner })
    caller.get('tuiEffectLedger')?.record(
      { operation: 'create', resource: { kind: 'scene', id }, result: 'applied' },
      identity,
    )
    const dispose = () => {
      if (state.scenes.get(id) !== normalized) return
      state.scenes.delete(id)
      state.owners.delete(id)
      sceneOwnerRecords.delete(normalized)
      clearSurfaceParams(sceneParamsKey(state, id))
      if (state.returnTo === normalized) state.returnTo = undefined
      caller.get('tuiEffectLedger')?.record(
        { operation: 'release', resource: { kind: 'scene', id }, result: 'applied' },
        identity,
      )
      // Disposing the open scene must not strand the user on a dead screen.
      if (state.current === normalized) {
        state.current = undefined
        notifyScenes(state, activationOwner)
      }
    }
    bindCallerEffect(caller, dispose)
    return dispose
  }

  /**
   * Swap the conversation for the named scene. Returns false (and warns)
   * when no plugin registered that id — a mistyped id must fail visibly in
   * the log, not silently do nothing in the UI. Optional `params` (JSON,
   * ≤16 KiB, frozen copy) reach the scene through `host.useParams()`;
   * re-opening the open scene with new params only updates them.
   */
  open(id: string, params?: TuiJsonValue): boolean {
    assertCapabilityShadowPolicy('host.scenes.open', sceneStateFor(this).runtime.mode, sceneStateFor(this).runtime.slices)
    const caller = requirePluginCaller(this.ctx, 'tuiScenes.open', this)
    const owner = activationFiber(caller)
    return owner === undefined ? false : openScene(this, id, caller, owner, params)
  }

  close(): void {
    assertCapabilityShadowPolicy('host.scenes.close', sceneStateFor(this).runtime.mode, sceneStateFor(this).runtime.slices)
    const caller = requirePluginCaller(this.ctx, 'tuiScenes.close', this)
    const owner = activationFiber(caller)
    if (owner !== undefined) closeScene(this, caller, owner)
  }

  /** The scene currently replacing the conversation, if any. */
  get active(): TuiSceneDescriptor | undefined {
    assertCapabilityShadowPolicy('host.scenes.active', sceneStateFor(this).runtime.mode, sceneStateFor(this).runtime.slices)
    const caller = requirePluginCaller(this.ctx, 'tuiScenes.active', this)
    const owner = activationFiber(caller)
    const state = sceneStateFor(this)
    return owner !== undefined && state.current !== undefined && state.owners.get(state.current.id) === owner
      ? state.current
      : undefined
  }

  /** UI-side change feed: fired after every open/close/dispose transition. */
  subscribe(listener: () => void): () => void {
    assertCapabilityShadowPolicy('host.scenes.subscribe', sceneStateFor(this).runtime.mode, sceneStateFor(this).runtime.slices)
    const caller = requirePluginCaller(this.ctx, 'tuiScenes.subscribe', this)
    const owner = activationFiber(caller)
    if (owner === undefined) return () => {}
    const dispose = subscribeScenes(this, listener, owner)
    bindCallerEffect(caller, dispose)
    return dispose
  }

}

interface SceneState {
  readonly runtime: AdapterRuntimeOptions
  readonly scenes: Map<string, TuiSceneDescriptor>
  readonly owners: Map<string, object>
  readonly listeners: Set<{ owner: object | undefined; listener: () => void }>
  current: TuiSceneDescriptor | undefined
  /** The plugin scene the host file preview covers; closing the preview
   *  lands back on it while it is still registered. */
  returnTo: TuiSceneDescriptor | undefined
  /** This registry's host file preview descriptor. */
  readonly filePreview: TuiSceneDescriptor
  host: TuiSceneHost | undefined
  readonly logger: Context['logger']
}

const sceneStates = new WeakMap<TuiSceneRuntime, SceneState>()
/** Which registry a registered descriptor belongs to (scene params scope). */
const sceneScopes = new WeakMap<TuiSceneDescriptor, SceneState>()

/** The params slot of a scene in this runtime's registry. */
export function sceneParamsKeyFor(runtime: TuiSceneRuntime, sceneId: string): string {
  return sceneParamsKey(sceneStateFor(runtime), sceneId)
}

/** The params slot of an active scene descriptor (registered or the host
 *  preview); a descriptor no registry knows reads its own, always empty slot. */
export function sceneParamsKeyOf(scene: TuiSceneDescriptor): string {
  return sceneParamsKey(sceneScopes.get(scene) ?? scene, scene.id)
}

function sceneStateFor(runtime: TuiSceneRuntime): SceneState {
  const state = sceneStates.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiScenes host state is unavailable')
  return state
}

function openScene(runtime: TuiSceneRuntime, id: string, caller?: Context, owner?: object, params?: unknown): boolean {
  const state = sceneStateFor(runtime)
  const scene = state.scenes.get(String(id ?? '').trim().toLowerCase())
  if (scene === undefined) {
    ;(caller?.logger ?? state.logger).warn(`dsh-tui: no TUI scene registered as "${id}"`)
    return false
  }
  if (owner !== undefined && state.owners.get(scene.id) !== owner) {
    caller?.logger.warn(`dsh-tui: scene "${scene.id}" belongs to another activation`)
    return false
  }
  const frozen = freezeSurfaceParams(params)
  if (!frozen.ok) {
    ;(caller?.logger ?? state.logger).warn(`dsh-tui: scene "${scene.id}" rejected its params — ${frozen.reason}`)
    return false
  }
  // Params land before the screen swaps, so the scene's first render reads them.
  setSurfaceParams(sceneParamsKey(state, scene.id), frozen.value)
  if (scene === state.current) return true
  const previousOwner = state.current === undefined ? undefined : state.owners.get(state.current.id)
  state.current = scene
  // An explicit open replaces whatever the file preview would return to.
  state.returnTo = undefined
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
  // Closing the host file preview lands back on the scene that opened it.
  const returnTo = state.current === state.filePreview && state.returnTo !== undefined
    && state.scenes.get(state.returnTo.id) === state.returnTo
    ? state.returnTo
    : undefined
  state.returnTo = undefined
  state.current = returnTo
  notifyScenes(state, previousOwner)
}

/**
 * Open the host-owned read-only file preview (`host.openFile`). The request
 * is already validated and resolved (surface-host `resolveSurfaceFileRequest`).
 * A plugin scene on screen becomes the return target; a preview already on
 * screen just takes the new file. False when the scenes service is missing
 * or the shadow policy denies a scene open.
 */
export function openHostFilePreview(service: TuiSceneRuntime | undefined, request: SurfaceFileRequest): boolean {
  if (service === undefined) return false
  let state: SceneState
  try {
    state = sceneStateFor(service)
    assertCapabilityShadowPolicy('host.scenes.open', state.runtime.mode, state.runtime.slices)
  } catch {
    return false
  }
  const params: TuiJsonValue = request.line === undefined
    ? Object.freeze({ path: request.path })
    : Object.freeze({ path: request.path, line: request.line })
  setSurfaceParams(sceneParamsKey(state, HOST_FILE_PREVIEW_SCENE_ID), params)
  if (state.current === state.filePreview) return true
  const previousOwner = state.current === undefined ? undefined : state.owners.get(state.current.id)
  state.returnTo = state.current
  state.current = state.filePreview
  notifyScenes(state, previousOwner)
  return true
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
  for (const entry of state.listeners) {
    if (entry.owner !== undefined && entry.owner !== currentOwner && entry.owner !== previousOwner) continue
    entry.listener()
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
