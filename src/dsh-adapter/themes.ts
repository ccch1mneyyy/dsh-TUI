/**
 * Cordis-backed runtime theme contributions.
 *
 * Plugins only receive `register`; the host-facing snapshot/resolver lives in a
 * module-local WeakMap and is exposed through `getHostThemes` to host code.
 * Runtime palettes are deliberately kept separate from custom-theme file
 * caches, so a file with the same name always wins in the static resolver.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { cleanRenderText } from './sanitize.js'
import {
  activationFiber,
  assertCallerContext,
  bindCallerEffect,
  compositionRoot,
  concreteService,
  requirePluginCaller,
} from './host-access.js'
import { isThemeBase, isThemeKey, isValidThemeColor } from '../customTheme.js'
import {
  AUTO_THEME_NAME,
  getTheme,
  registerRuntimeThemeResolver,
  THEME_NAMES,
  type Theme,
} from '../theme.js'

/** The built-in palette a runtime theme overlays. */
export type TuiThemeBase = 'light' | 'dark' | 'dsh' | 'dark-ansi'

/** Plugin-facing runtime theme declaration. */
export interface TuiThemeDescriptor {
  readonly name: string
  readonly displayName?: string
  readonly base: TuiThemeBase
  readonly colors?: Readonly<Partial<Theme>>
}

/** A validated, immutable contribution visible to host catalog consumers. */
export interface TuiThemeRegistration {
  readonly name: string
  readonly displayName: string
  readonly base: TuiThemeBase
  readonly colors: Readonly<Partial<Theme>>
}

/** Host-only read surface for runtime themes. */
export interface TuiThemeHost {
  getSnapshot(): readonly TuiThemeRegistration[]
  resolve(name: string): Theme | undefined
  subscribe(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiThemes: TuiThemeRuntime
  }
}

const NAME_PATTERN = /^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_-]*)?$/u
const MAX_NAME_LENGTH = 128
const DISPLAY_NAME_CELLS = 120
const MAX_RUNTIME_THEMES = 128
const RESERVED_NAMES = new Set<string>([
  AUTO_THEME_NAME,
  'status',
  ...THEME_NAMES,
])

const NOOP = (): void => {}

interface ValidatedTheme {
  readonly name: string
  readonly displayName: string
  readonly base: TuiThemeBase
  readonly colors: Readonly<Partial<Theme>>
}

interface RuntimeThemeEntry extends TuiThemeRegistration {
  readonly owner: object
  readonly theme: Theme
}

interface ThemeState {
  readonly hostContext: Context
  readonly entries: Map<string, RuntimeThemeEntry>
  readonly listeners: Set<() => void>
  snapshot: readonly TuiThemeRegistration[]
  host: TuiThemeHost | undefined
  resolverCleanup: (() => void) | undefined
  disposed: boolean
}

const hostThemes = new WeakMap<TuiThemeRuntime, ThemeState>()

function warn(ctx: Context, message: string): void {
  try {
    ctx.logger.warn(`dsh-tui: ${message}`)
  } catch {
    // A logger is observability only; malformed plugin data must stay inert.
  }
}

function normalizeRuntimeName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (/[\x00-\x1f\x7f-\x9f]/u.test(value)) return undefined
  const trimmed = value.trim()
  if (
    trimmed === '' ||
    trimmed.length > MAX_NAME_LENGTH ||
    trimmed.includes('/') ||
    trimmed.includes('\\')
  ) return undefined
  const normalized = trimmed.toLowerCase()
  if (!NAME_PATTERN.test(normalized) || RESERVED_NAMES.has(normalized)) return undefined
  return normalized
}

function validateDescriptor(value: unknown): ValidatedTheme | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const name = normalizeRuntimeName(raw.name)
  if (name === undefined) return undefined
  if (!isThemeBase(raw.base)) return undefined
  const base = raw.base as TuiThemeBase

  let displayName = cleanRenderText(name, DISPLAY_NAME_CELLS)
  if (raw.displayName !== undefined) {
    if (typeof raw.displayName !== 'string') return undefined
    const cleaned = cleanRenderText(raw.displayName, DISPLAY_NAME_CELLS)
    if (cleaned !== '') displayName = cleaned
  }

  const colorsRaw = raw.colors
  const colors: Partial<Theme> = {}
  if (colorsRaw !== undefined) {
    if (colorsRaw === null || typeof colorsRaw !== 'object' || Array.isArray(colorsRaw)) return undefined
    for (const [key, color] of Object.entries(colorsRaw)) {
      if (!isThemeKey(key) || !isValidThemeColor(color)) return undefined
      colors[key] = color
    }
  }

  return {
    name,
    displayName,
    base,
    colors: Object.freeze(colors),
  }
}

function themeStateFor(runtime: TuiThemeRuntime): ThemeState {
  const state = hostThemes.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiThemes host state is unavailable')
  return state
}

function emit(state: ThemeState): void {
  state.snapshot = Object.freeze(
    [...state.entries.values()].map(entry => Object.freeze({
      name: entry.name,
      displayName: entry.displayName,
      base: entry.base,
      colors: entry.colors,
    })),
  )
  for (const listener of [...state.listeners]) {
    try {
      listener()
    } catch {
      // Host listeners are not allowed to take down registration or teardown.
    }
  }
}

function resolveRuntimeTheme(runtime: TuiThemeRuntime, name: string): Theme | undefined {
  let normalized: string | undefined
  try {
    normalized = normalizeRuntimeName(name)
  } catch {
    return undefined
  }
  if (normalized === undefined) return undefined
  return themeStateFor(runtime).entries.get(normalized)?.theme
}

function subscribeRuntimeTheme(runtime: TuiThemeRuntime, listener: () => void): () => void {
  const state = themeStateFor(runtime)
  if (typeof listener !== 'function' || state.disposed) return NOOP
  state.listeners.add(listener)
  return () => {
    state.listeners.delete(listener)
  }
}

function recordThemeEffect(
  caller: Context,
  identity: Context | undefined,
  operation: 'create' | 'release',
  name: string,
  result: 'applied' | 'failed',
  errorCode?: string,
): void {
  try {
    caller.get('tuiEffectLedger')?.record(
      {
        operation,
        resource: { kind: 'theme', id: name },
        result,
        ...(errorCode === undefined ? {} : { errorCode }),
      },
      identity,
    )
  } catch {
    // Ledger writes are explicitly best-effort and must not affect the seam.
  }
}

/** `ctx.tuiThemes` — plugin runtime theme registry. */
export class TuiThemeRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tuiThemes')
    const runtime = this
    const state: ThemeState = {
      hostContext: compositionRoot(ctx),
      entries: new Map(),
      listeners: new Set(),
      snapshot: Object.freeze([]),
      host: undefined,
      resolverCleanup: undefined,
      disposed: false,
    }
    hostThemes.set(this, state)
    state.host = Object.freeze({
      getSnapshot: () => themeStateFor(runtime).snapshot,
      resolve: (name: string) => resolveRuntimeTheme(runtime, name),
      subscribe: (listener: () => void) => subscribeRuntimeTheme(runtime, listener),
    })
    // The resolver is process-global for non-React consumers. Its token-safe
    // cleanup means an older composition cannot clear a newer host's resolver.
    state.resolverCleanup = registerRuntimeThemeResolver(
      name => resolveRuntimeTheme(runtime, name),
    )
    ctx.effect(() => () => {
      if (state.disposed) return
      state.disposed = true
      state.resolverCleanup?.()
      state.resolverCleanup = undefined
      if (state.entries.size > 0) {
        state.entries.clear()
        emit(state)
      }
      state.listeners.clear()
    })
  }

  /**
   * Register one immutable runtime palette. Invalid and duplicate declarations
   * warn and return an inert disposer; successful registrations are bound to
   * the caller's Cordis activation and disappear with that activation.
   */
  register(descriptor: TuiThemeDescriptor, identity?: Context): () => void {
    try {
      const caller = requirePluginCaller(this.ctx, 'tuiThemes.register', this)
      const state = themeStateFor(this)
      const owner = activationFiber(caller)
      if (owner === undefined || state.disposed) {
        warn(caller, 'tuiThemes.register requires a live activation')
        return NOOP
      }
      if (identity !== undefined) {
        try {
          assertCallerContext(caller, identity, 'tuiThemes.register', this)
        } catch {
          warn(caller, 'tuiThemes.register rejected an identity belonging to another activation')
          return NOOP
        }
      }

      let validated: ValidatedTheme | undefined
      try {
        validated = validateDescriptor(descriptor)
      } catch {
        validated = undefined
      }
      if (validated === undefined) {
        warn(caller, 'tuiThemes.register rejected an invalid theme descriptor')
        return NOOP
      }

      const existing = state.entries.get(validated.name)
      if (existing !== undefined) {
        warn(caller, `tuiThemes.register rejected "${validated.name}" — already registered`)
        recordThemeEffect(
          caller,
          identity,
          'create',
          validated.name,
          'failed',
          'DUPLICATE_CONTRIBUTION_ID',
        )
        return NOOP
      }
      if (state.entries.size >= MAX_RUNTIME_THEMES) {
        warn(caller, `tuiThemes.register rejected "${validated.name}" — registry limit reached`)
        return NOOP
      }

      const entry: RuntimeThemeEntry = Object.freeze({
        ...validated,
        owner,
        theme: Object.freeze({ ...getTheme(validated.base), ...validated.colors }),
      })
      state.entries.set(entry.name, entry)
      emit(state)
      recordThemeEffect(caller, identity, 'create', entry.name, 'applied')

      let disposed = false
      const dispose = (): void => {
        if (disposed) return
        disposed = true
        const current = state.entries.get(entry.name)
        if (current !== entry || current.owner !== owner) return
        state.entries.delete(entry.name)
        emit(state)
        recordThemeEffect(caller, identity, 'release', entry.name, 'applied')
      }
      // Binding can fail when the caller's activation is already tearing down;
      // the entry is live at this point, so undo the registration before
      // reporting failure — otherwise the theme outlives its plugin.
      if (!bindCallerEffect(caller, dispose)) {
        dispose()
        return NOOP
      }
      return dispose
    } catch {
      try {
        this.ctx.logger.warn('dsh-tui: tuiThemes.register rejected malformed data')
      } catch {
        // Never let a malformed plugin descriptor crash the TUI.
      }
      return NOOP
    }
  }
}

/** Host-only accessor; intentionally omitted from `src/extensions.ts`. */
export function getHostThemes(runtime: TuiThemeRuntime | undefined): TuiThemeHost | undefined {
  if (runtime === undefined) return undefined
  try {
    return themeStateFor(runtime).host
  } catch {
    return undefined
  }
}

export default TuiThemeRuntime
