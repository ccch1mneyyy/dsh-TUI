import React from 'react'
import * as ui from '../ui.js'
import { adapterRuntimeFor } from '../adapter/kernel/runtime-context.js'
import type { ChannelUi } from '../adapter/ports/channel-ui.js'
import { TerminalWriteContext } from '../ink/useTerminalNotification.js'
import { FilePreviewScene } from '../components/FilePreviewScene.js'
import { buildPanelSnapshot } from '../components/sidePanel/panelSnapshot.js'
import { PanelCodeBlock, PanelMarkdown } from '../components/sidePanel/panelMarkdown.js'
import type { TuiPluginStorage } from './plugin-storage.js'
import {
  HOST_FILE_PREVIEW_SCENE_ID,
  openHostFilePreview,
  sceneOwnerRecordOf,
  sceneParamsKeyOf,
  type SceneOwnerRecord,
  type TuiSceneDescriptor,
  type TuiSceneHostApi,
  type TuiSceneProps,
  type TuiSceneUi,
  type TuiSceneRuntime,
} from './scenes.js'
import {
  resolveSurfaceFileRequest,
  surfaceCopy,
  surfaceOpenSession,
  useSurfaceParams,
  type TuiJsonValue,
  type TuiSceneRenderContext,
} from './surface-host.js'

/** The `ui` every scene receives: the facade module plus the panel kit's
 *  narrowed `Markdown` / `CodeBlock`. Built once, so its identity is stable
 *  across renders. */
const SCENE_UI: TuiSceneUi = Object.freeze({ ...ui, Markdown: PanelMarkdown, CodeBlock: PanelCodeBlock })

/** Host-owned scenes resolve their component here, not in the registry. A
 *  Map, not an object literal: a plugin scene id such as `constructor` or
 *  `__proto__` must never resolve to an `Object.prototype` member. */
const HOST_SCENE_COMPONENTS: ReadonlyMap<string, React.ComponentType<TuiSceneProps>> = new Map([
  [HOST_FILE_PREVIEW_SCENE_ID, FilePreviewScene],
])

/** Renderer-only outlet. Component identity stays in the existing scene registry. */
export function createChannelSceneOutlet(current: () => TuiSceneDescriptor | undefined) {
  return (id: string, channel: ChannelUi, context?: TuiSceneRenderContext): React.ReactNode => {
    const scene = current()
    if (scene?.id !== id) throw new Error(`Scene unavailable: ${id}`)
    return React.createElement(PluginSceneHost, { key: scene.id, scene, channel, context })
  }
}

interface PluginSceneHostProps {
  readonly scene: TuiSceneDescriptor
  readonly channel: ChannelUi
  readonly context: TuiSceneRenderContext | undefined
}

/** A service the registering activation reaches through its own ctx (same
 *  checks the plugin itself would hit); undefined when gone or unmounted. */
function callerService<T>(record: SceneOwnerRecord | undefined, name: string): T | undefined {
  if (record === undefined) return undefined
  try {
    return (record.caller as unknown as { get(name: string): unknown }).get(name) as T | undefined
  } catch {
    return undefined
  }
}

function sceneStorage(record: SceneOwnerRecord | undefined): TuiPluginStorage | undefined {
  if (record === undefined) return undefined
  if (record.storage !== undefined) return record.storage
  const service = callerService<{ open(pluginCtx: unknown): TuiPluginStorage }>(record, 'tuiPluginStorage')
  if (service === undefined || typeof service.open !== 'function') return undefined
  try {
    record.storage = service.open(record.caller)
    return record.storage
  } catch {
    return undefined
  }
}

/**
 * Builds the scene's `host` (TuiSceneHostApi) and renders the scene. The
 * verbs act as the activation that registered the scene — the same identity
 * its own `ctx` calls carry — so ownership checks, rate limits and the shadow
 * policy apply exactly as for a direct service call. Host-owned scenes (the
 * file preview) have no plugin identity: their plugin-scoped verbs refuse.
 * The registering activation is looked up per call, never captured: disposing
 * the registration drops it, so a callback the scene kept past its unload
 * (a pending promise, a timer) acts as no one and every verb refuses.
 */
function PluginSceneHost({ scene, channel, context }: PluginSceneHostProps): React.ReactNode {
  const writeRaw = React.useContext(TerminalWriteContext)
  const activity = context?.activity
  const approvals = context?.attention?.approvals ?? 0
  const questions = context?.attention?.questions ?? 0
  const close = React.useCallback(() => { channel.closePluginScene() }, [channel])
  // The scene's params slot in ITS registry (scene ids are per composition).
  const paramsKey = React.useMemo(() => sceneParamsKeyOf(scene), [scene])
  const host = React.useMemo<TuiSceneHostApi>(() => {
    const owner = (): SceneOwnerRecord | undefined => sceneOwnerRecordOf(scene)
    const warn = (message: string) => { owner()?.caller.logger.warn(message) }
    return {
      snapshot: () => buildPanelSnapshot(channel, activity, { approvals, questions }),
      get storage() { return sceneStorage(owner()) },
      openSession: sessionId => {
        const record = owner()
        return surfaceOpenSession(
          record === undefined ? undefined : { owner: record.owner, runtime: adapterRuntimeFor(record.caller) },
          channel,
          sessionId,
          warn,
        )
      },
      openFile: (path, options) => {
        // Relative paths resolve against the session cwd at call time.
        const request = resolveSurfaceFileRequest(channel.cwd, path, options, warn)
        if (request === undefined) return false
        return openHostFilePreview(callerService<TuiSceneRuntime>(owner(), 'tuiScenes'), request)
      },
      copy: text => {
        const record = owner()
        return surfaceCopy(
          record === undefined ? undefined : { owner: record.owner, runtime: adapterRuntimeFor(record.caller) },
          text,
          writeRaw,
          message => { channel.notify(message, { timeoutMs: 1500 }) },
          warn,
        )
      },
      openScene: (sceneId: string, params?: TuiJsonValue) => {
        const scenes = callerService<{ open(id: string, params?: TuiJsonValue): boolean }>(owner(), 'tuiScenes')
        if (scenes === undefined || typeof scenes.open !== 'function') return false
        try {
          return params === undefined ? scenes.open(sceneId) : scenes.open(sceneId, params)
        } catch {
          return false
        }
      },
      openPanel: (panelId: string, params?: TuiJsonValue) => {
        const panels = callerService<{ open(id: string, params?: TuiJsonValue): boolean }>(owner(), 'tuiPanels')
        if (panels === undefined || typeof panels.open !== 'function') return false
        try {
          return params === undefined ? panels.open(panelId) : panels.open(panelId, params)
        } catch {
          return false
        }
      },
      useParams: () => useSurfaceParams(paramsKey),
      toast: text => {
        const toast = callerService<{ show(text: string): boolean }>(owner(), 'tuiToast')
        if (toast === undefined || typeof toast.show !== 'function') return false
        try {
          return toast.show(text)
        } catch {
          return false
        }
      },
    }
  }, [scene, paramsKey, channel, activity, approvals, questions, writeRaw])
  const component = HOST_SCENE_COMPONENTS.get(scene.id) ?? scene.component
  return React.createElement(component, { React, ui: SCENE_UI, channel, close, host })
}
