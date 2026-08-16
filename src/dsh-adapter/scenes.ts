/** Provider-neutral full-screen scene registry for terminal front doors. */

import type React from 'react'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Channel } from './channel.js'

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
export interface TuiSceneProps {
  /** The TUI's React instance — use THIS for every hook and element. */
  React: typeof React
  /** The TUI's ui kit (Box/Text/useInput/useTerminalSize/…). */
  ui: typeof import('../ui.js')
  /** Live session channel: rows, status, trace events, notifications. */
  channel: Channel
  /** Leave the scene and return to whatever screen was up before. */
  close(): void
}

export interface TuiSceneDescriptor {
  /** Unique scene id (kebab-case); the plugin's own commands open it by id. */
  id: string
  /** Optional human label for logs/debugging; the scene renders its own header. */
  title?: string
  component: React.ComponentType<TuiSceneProps>
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
  private readonly scenes = new Map<string, TuiSceneDescriptor>()
  private readonly listeners = new Set<() => void>()
  private current: TuiSceneDescriptor | undefined

  constructor(ctx: Context) {
    super(ctx, 'tuiScenes')
  }

  register(descriptor: TuiSceneDescriptor): () => void {
    const id = descriptor.id.trim().toLowerCase()
    if (!/^[a-z][a-z0-9_-]*$/u.test(id)) throw new TypeError(`invalid TUI scene id: ${descriptor.id}`)
    if (this.scenes.has(id)) throw new Error(`TUI scene "${id}" is already registered`)
    const normalized = { ...descriptor, id }
    this.scenes.set(id, normalized)
    return () => {
      if (this.scenes.get(id) !== normalized) return
      this.scenes.delete(id)
      // Disposing the open scene must not strand the user on a dead screen.
      if (this.current === normalized) {
        this.current = undefined
        this.notify()
      }
    }
  }

  /**
   * Swap the conversation for the named scene. Returns false (and warns)
   * when no plugin registered that id — a mistyped id must fail visibly in
   * the log, not silently do nothing in the UI.
   */
  open(id: string): boolean {
    const scene = this.scenes.get(id.trim().toLowerCase())
    if (scene === undefined) {
      this.ctx.logger.warn(`dsh-tui: no TUI scene registered as "${id}"`)
      return false
    }
    if (scene === this.current) return true
    this.current = scene
    this.notify()
    return true
  }

  close(): void {
    if (this.current === undefined) return
    this.current = undefined
    this.notify()
  }

  /** The scene currently replacing the conversation, if any. */
  get active(): TuiSceneDescriptor | undefined {
    return this.current
  }

  /** UI-side change feed: fired after every open/close/dispose transition. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export default TuiSceneRuntime
