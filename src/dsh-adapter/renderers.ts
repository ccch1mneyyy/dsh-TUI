/**
 * Custom session-entry renderers — pi's `pi.registerMessageRenderer`. A
 * plugin that appends its own log-only session events (`session.append(
 * 'my-plugin/event', payload)`) registers a renderer mapping the payload to
 * plain TEXT rows; the channel then projects those events into the
 * transcript on the live stream and on replay (resume/rewind), exactly like
 * its built-in projection of `activity/status` or `agent-preset/selected`.
 *
 * Renderers are text-only by design: the full-React surface is the scenes
 * seam (`ctx.tuiScenes`, with the host-React contract); transcript rows are
 * shared with replay paths where a crash mid-replay would corrupt the whole
 * screen, so a renderer never receives React and its output is sanitized
 * (control chars stripped, lines preview-clipped like `pushLocal` output).
 *
 * Registration rules (untrusted-input discipline):
 *
 * - The type must look like `plugin/event` (kebab, one slash) — this is the
 *   same shape the session-log strict registry expects plugins to register.
 * - Core vocabulary is off-limits: a renderer can never shadow a built-in
 *   event type's projection (locals win, same as commands).
 * - A renderer that throws is skipped for THAT event and logged once per
 *   type — replay must survive a buggy plugin.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { cleanRenderText } from './sanitize.js'
import { bindCallerEffect, compositionRoot, concreteService, requirePluginCaller } from './host-access.js'

/** What a renderer returns: an optional title row plus body lines. */
export interface TuiEntryRenderResult {
  /** Short heading (rendered as a notice row); omit for a body-only entry. */
  title?: string
  /** Body rows, oldest-to-newest reading order. */
  lines: readonly string[]
}

export type TuiEntryRenderer = (payload: unknown) => TuiEntryRenderResult | undefined

/** Host-only transcript projection path. Plugins can register a renderer but
 * cannot invoke an arbitrary registered renderer on demand. */
export interface TuiRendererHost {
  render(type: string, payload: unknown): TuiEntryRenderResult | undefined
}

const TYPE_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/u

/**
 * The built-in session-event vocabulary, FROZEN at module load. The live
 * KNOWN_SESSION_EVENT_TYPES set cannot serve as this denylist: a plugin
 * persisting custom events MUST add its types to that set (seam 1's hard
 * rule), so by the time it registers a renderer for `my-plugin/note`, the
 * mutable set already contains `my-plugin/note` — checking against it would
 * reject exactly the types this seam exists for. The module-load snapshot
 * (this service's row mounts before any plugin row) is the built-in truth.
 */
const BUILTIN_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set(KNOWN_SESSION_EVENT_TYPES)

/** Output bounds (render-path hygiene): a renderer runs on the REPLAY path
 *  too, where an unbounded result would synchronously create thousands of
 *  transcript rows. Sanitization itself lives in ./sanitize.js. */
const MAX_RENDER_LINES = 100
const TITLE_CELLS = 120
const LINE_CELLS = 400

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiRenderers: TuiRendererRuntime
  }
}

/** `ctx.tuiRenderers` — custom session-entry text renderers. */
export class TuiRendererRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tuiRenderers')
    compositionRoot(ctx)
    const runtime = this
    const state: RendererState = {
      renderers: new Map(),
      failedTypes: new Set(),
      host: undefined,
      logger: ctx.logger,
    }
    const host: TuiRendererHost = Object.freeze({ render: (type, payload) => renderEntry(runtime, type, payload) })
    state.host = host
    hostRenderers.set(runtime, state)
  }

  /**
   * Map a log-only session event type to transcript rows. Returns the
   * dispose function (caller scopes it with `ctx.effect`, same contract as
   * `tuiScenes`). Refusals warn instead of throwing. The optional trailing
   * `identity` (the plugin's own ctx) only feeds the effect ledger's
   * pluginId — omitting it records `undeclared` (C-060).
   */
  register(type: string, renderer: TuiEntryRenderer, identity?: Context): () => void {
    let caller: Context
    try {
      caller = requirePluginCaller(this.ctx, 'tuiRenderers.register', this)
    } catch {
      this.ctx.logger.warn('dsh-tui: tuiRenderers.register requires a live non-root plugin activation')
      return () => {}
    }
    const state = rendererStateFor(this)
    let normalized: string
    try {
      normalized = String(type ?? '').trim().toLowerCase()
    } catch {
      this.ctx.logger.warn('dsh-tui: tuiRenderers.register rejected an uncoercible event type')
      return () => {}
    }
    if (!TYPE_PATTERN.test(normalized)) {
      this.ctx.logger.warn('dsh-tui: tuiRenderers.register rejected an invalid event type')
      return () => {}
    }
    // The channel's own projection (its renderEvent switch plus special-
    // cased plugin events like agent-preset/selected) always wins. The check
    // uses the module-load snapshot of the built-in vocabulary — NOT the live
    // KNOWN_SESSION_EVENT_TYPES, which plugins must extend with their own
    // types (see BUILTIN_SESSION_EVENT_TYPES above).
    if (BUILTIN_SESSION_EVENT_TYPES.has(normalized) || normalized === 'agent-preset/selected') {
      this.ctx.logger.warn(`dsh-tui: tuiRenderers.register rejected "${normalized}" — built-in event types keep their own projection`)
      return () => {}
    }
    if (state.renderers.has(normalized)) {
      this.ctx.logger.warn(`dsh-tui: tuiRenderers.register rejected "${normalized}" — already registered`)
      this.ctx.get('tuiEffectLedger')?.record(
        {
          operation: 'create',
          resource: { kind: 'renderer', id: normalized },
          result: 'failed',
          errorCode: 'DUPLICATE_CONTRIBUTION_ID',
        },
        identity,
      )
      return () => {}
    }
    if (typeof renderer !== 'function') {
      this.ctx.logger.warn(`dsh-tui: tuiRenderers.register rejected "${normalized}" — renderer must be a function`)
      return () => {}
    }
    state.renderers.set(normalized, renderer)
    this.ctx.get('tuiEffectLedger')?.record(
      { operation: 'create', resource: { kind: 'renderer', id: normalized }, result: 'applied' },
      identity,
    )
    const dispose = () => {
      if (state.renderers.get(normalized) !== renderer) return
      state.renderers.delete(normalized)
      this.ctx.get('tuiEffectLedger')?.record(
        { operation: 'release', resource: { kind: 'renderer', id: normalized }, result: 'applied' },
        identity,
      )
    }
    bindCallerEffect(caller, dispose)
    return dispose
  }
}

/** Host-only renderer dispatcher; not included in the package export map. */
interface RendererState {
  readonly renderers: Map<string, TuiEntryRenderer>
  readonly failedTypes: Set<string>
  host: TuiRendererHost | undefined
  readonly logger: Context['logger']
}

const hostRenderers = new WeakMap<TuiRendererRuntime, RendererState>()

function rendererStateFor(runtime: TuiRendererRuntime): RendererState {
  const state = hostRenderers.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiRenderers host state is unavailable')
  return state
}

function renderEntry(runtime: TuiRendererRuntime, type: string, payload: unknown): TuiEntryRenderResult | undefined {
  const state = rendererStateFor(runtime)
  const renderer = state.renderers.get(type)
  if (renderer === undefined) return undefined
  try {
    const result = renderer(payload)
    if (result === undefined) return undefined
    const raw = result as { title?: unknown; lines?: unknown }
    if (!Array.isArray(raw.lines)) return undefined
    const lines: string[] = []
    for (const line of raw.lines) {
      if (lines.length >= MAX_RENDER_LINES) break
      if (typeof line !== 'string' && typeof line !== 'number' && typeof line !== 'boolean') continue
      lines.push(cleanRenderText(String(line), LINE_CELLS))
    }
    const title = typeof raw.title === 'string' ? cleanRenderText(raw.title, TITLE_CELLS) : undefined
    return { ...(title === undefined || title === '' ? {} : { title }), lines }
  } catch (error) {
    if (!state.failedTypes.has(type)) {
      state.failedTypes.add(type)
      state.logger.warn(`dsh-tui: renderer for "${type}" threw; its entries are skipped: %o`, error)
    }
    return undefined
  }
}

export function getHostRenderers(runtime: TuiRendererRuntime | undefined): TuiRendererHost | undefined {
  if (runtime === undefined) return undefined
  try {
    return hostRenderers.get(concreteService(runtime))?.host
  } catch {
    return undefined
  }
}

export default TuiRendererRuntime
