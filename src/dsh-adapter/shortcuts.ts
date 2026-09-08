/**
 * Plugin keyboard shortcuts — pi's `pi.registerShortcut`. A plugin binds a
 * combo (`ctrl+shift+p`, `alt+k`, …) to a handler; the chat screen matches
 * combos against keypresses that survived every built-in binding and runs
 * the handler, consuming the key.
 *
 * Precedence rule (same philosophy as the command list: a plugin shadows
 * nothing built in):
 *
 * - Combos must carry ctrl or alt (meta) — bare letters are typing, and
 *   bare Esc/arrows are navigation. Rejected at registration.
 * - A RESERVED list (fixed combos the TUI itself binds globally or in the
 *   prompt editor, PLUS the effective combos of every customizable built-in
 *   action from src/utils/keymap.ts) is refused at registration with a
 *   warning. The list is the enforcement of "locals win": collisions can
 *   never reach the matcher — and it follows user remaps made in /settings.
 * - Overlays (pickers, dialogs, scenes, the session browser) own the
 *   keyboard while open; shortcuts match only in the plain chat state.
 *
 * Handlers are fire-and-forget from the UI's point of view: async handlers
 * are awaited but their rejection is caught and toasted — a throwing
 * handler must never break the keyboard for everyone else.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { cleanScalarText } from './sanitize.js'
import { activationFiber, bindCallerEffect, compositionRoot, concreteService, requirePluginCaller } from './host-access.js'
import {
  canonicalCombo,
  comboMatchesStrict,
  fixedReservedCombos,
  parseCombo,
  reservedActionCombos,
  type ComboKeyFlags,
  type ParsedCombo,
} from '../utils/keymap.js'

/**
 * Minimal shape of the ink Key flags the matcher reads (kept structurally
 * compatible with `Key` from the ui kit without importing React-facing
 * modules into the adapter).
 */
export type TuiShortcutKey = ComboKeyFlags

// Shared combo grammar + built-in keymap live in src/utils/keymap.ts; the
// parse/match entry points stay re-exported here for API stability.
export const parseShortcutCombo = parseCombo
export const matchShortcut = comboMatchesStrict
export type { ParsedCombo }

/** Controls that only the Chat input path may use. They are kept out of the
 * Cordis service object, so one plugin cannot synthesize an input event to
 * invoke another plugin's shortcut handler. */
export interface TuiShortcutHost {
  dispatch(input: string, key: TuiShortcutKey): boolean
  setErrorHandler(handler: (combo: string, error: unknown) => void): () => void
}

export interface TuiShortcutOptions {
  /** Required one-line label returned by list() for diagnostics. */
  description: string
  handler: () => void | Promise<void>
}

interface RegisteredShortcut {
  readonly combo: ParsedCombo
  readonly description: string
  readonly handler: () => void | Promise<void>
}

/**
 * The fixed half of the reserved set lives in src/utils/keymap.ts
 * (FIXED_RESERVED_COMBOS) so the /settings draft validator and this
 * registry agree on one list; the customizable action combos join here
 * dynamically via `reservedActionCombos()` so a user remap (say
 * paste → alt+v) moves the reservation with the binding.
 */
const FIXED_RESERVED_CANONICAL = fixedReservedCombos()

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiShortcuts: TuiShortcutRuntime
  }
}

/** `ctx.tuiShortcuts` — plugin keyboard shortcut registry. */
export class TuiShortcutRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tuiShortcuts')
    compositionRoot(ctx)
    const runtime = this
    const state: ShortcutState = {
      shortcuts: new Map(),
      owners: new Map(),
      onError: undefined,
      host: undefined,
      logger: ctx.logger,
    }
    const host: TuiShortcutHost = Object.freeze({
      dispatch: (input, key) => dispatchShortcut(runtime, input, key),
      setErrorHandler: (handler) => {
        state.onError = handler
        return () => {
          if (state.onError === handler) state.onError = undefined
        }
      },
    })
    state.host = host
    hostShortcuts.set(runtime, state)
  }

  /**
   * Bind `combo` to `handler`. Invalid, modifier-less, reserved, or
   * duplicate combos are refused with a logger warning rather than a throw
   * — a bad binding must not fail the plugin's whole boot.
   *
   * Returns the dispose function; the CALLER scopes it to its own fiber
   * (`ctx.effect(() => dispose)`) — the same contract as `tuiScenes`
   * registration. (A service method only sees the service's own ctx, so
   * caller-fiber cleanup cannot happen here.)
   *
   * The optional trailing `identity` (the plugin's own ctx) only feeds the
   * effect ledger's pluginId — omitting it records `undeclared` (C-060).
   */
  register(combo: string, options: TuiShortcutOptions, identity?: Context): () => void {
    let caller: Context
    try {
      caller = requirePluginCaller(this.ctx, 'tuiShortcuts.register', this)
    } catch {
      this.ctx.logger.warn('dsh-tui: tuiShortcuts.register requires a live non-root plugin activation')
      return () => {}
    }
    const state = shortcutStateFor(this)
    const owner = activationFiber(caller)
    if (owner === undefined) {
      this.ctx.logger.warn('dsh-tui: tuiShortcuts.register requires a live activation')
      return () => {}
    }
    let parsed: ParsedCombo | undefined
    try {
      parsed = parseShortcutCombo(combo)
    } catch {
      this.ctx.logger.warn('dsh-tui: tuiShortcuts.register rejected an uncoercible combo')
      return () => {}
    }
    if (parsed === undefined) {
      this.ctx.logger.warn(
        'dsh-tui: tuiShortcuts.register rejected an invalid combo — need ctrl/alt plus one key (e.g. "ctrl+shift+p")',
      )
      return () => {}
    }
    const key = canonicalCombo(parsed)
    // Built-ins match a modifier subset (see FIXED_RESERVED_COMBOS): a combo
    // whose SHIFTLESS form is reserved collides with the built-in on
    // terminals that don't report Shift distinctly, so it is refused too.
    // The exact form is still checked for combos reserved WITH shift
    // (ctrl+shift+return). The customizable action combos join the check
    // dynamically, so a user remap (paste → alt+v) reserves the new combo
    // from the moment the settings layer applies it.
    const shiftlessKey = canonicalCombo({ ...parsed, shift: false })
    const actionReserved = reservedActionCombos()
    if (
      FIXED_RESERVED_CANONICAL.has(key) || FIXED_RESERVED_CANONICAL.has(shiftlessKey) ||
      actionReserved.has(key) || actionReserved.has(shiftlessKey)
    ) {
      this.ctx.logger.warn(`dsh-tui: tuiShortcuts.register rejected "${parsed.raw}" — reserved by a built-in binding`)
      return () => {}
    }
    if (state.shortcuts.has(key)) {
      this.ctx.logger.warn(`dsh-tui: tuiShortcuts.register rejected "${parsed.raw}" — already registered`)
      this.ctx.get('tuiEffectLedger')?.record(
        {
          operation: 'bind',
          resource: { kind: 'shortcut', id: key },
          result: 'failed',
          errorCode: 'DUPLICATE_CONTRIBUTION_ID',
        },
        identity,
      )
      return () => {}
    }
    let description: string
    let handler: (() => void | Promise<void>) | undefined
    try {
      description = cleanScalarText(options?.description, 120)
      handler = options?.handler
    } catch {
      this.ctx.logger.warn(`dsh-tui: tuiShortcuts.register rejected "${parsed.raw}" — malformed options`)
      return () => {}
    }
    if (typeof handler !== 'function' || description === '') {
      this.ctx.logger.warn(`dsh-tui: tuiShortcuts.register rejected "${parsed.raw}" — needs a description and a handler`)
      return () => {}
    }
    const entry: RegisteredShortcut = { combo: parsed, description, handler }
    state.shortcuts.set(key, entry)
    state.owners.set(key, owner)
    this.ctx.get('tuiEffectLedger')?.record(
      { operation: 'bind', resource: { kind: 'shortcut', id: key }, result: 'applied' },
      identity,
    )
    const dispose = (): void => {
      if (state.shortcuts.get(key) !== entry) return
      state.shortcuts.delete(key)
      state.owners.delete(key)
      this.ctx.get('tuiEffectLedger')?.record(
        { operation: 'release', resource: { kind: 'shortcut', id: key }, result: 'applied' },
        identity,
      )
    }
    bindCallerEffect(caller, dispose)
    return dispose
  }

  /** Combos and descriptions owned by the calling plugin activation. */
  list(): readonly { combo: string; description: string }[] {
    const caller = requirePluginCaller(this.ctx, 'tuiShortcuts.list', this)
    const owner = activationFiber(caller)
    if (owner === undefined) return []
    const state = shortcutStateFor(this)
    return [...state.shortcuts.entries()]
      .filter(([key]) => state.owners.get(key) === owner)
      .map(([, entry]) => ({ combo: entry.combo.raw, description: entry.description }))
  }
}

/** Host-only dispatch accessor; this module is not exposed through package
 * exports, while the Cordis capability remains register/list only. */
interface ShortcutState {
  readonly shortcuts: Map<string, RegisteredShortcut>
  readonly owners: Map<string, object>
  onError: ((combo: string, error: unknown) => void) | undefined
  host: TuiShortcutHost | undefined
  readonly logger: Context['logger']
}

const hostShortcuts = new WeakMap<TuiShortcutRuntime, ShortcutState>()

function shortcutStateFor(runtime: TuiShortcutRuntime): ShortcutState {
  const state = hostShortcuts.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiShortcuts host state is unavailable')
  return state
}

function dispatchShortcut(runtime: TuiShortcutRuntime, input: string, key: TuiShortcutKey): boolean {
  const state = shortcutStateFor(runtime)
  for (const entry of state.shortcuts.values()) {
    if (!matchShortcut(entry.combo, input, key)) continue
    Promise.resolve()
      .then(() => entry.handler())
      .catch((error: unknown) => {
        state.onError?.(entry.combo.raw, error)
        state.logger.warn(`dsh-tui: shortcut "${entry.combo.raw}" handler failed: %o`, error)
      })
    return true
  }
  return false
}

export function getHostShortcuts(runtime: TuiShortcutRuntime | undefined): TuiShortcutHost | undefined {
  if (runtime === undefined) return undefined
  try {
    return hostShortcuts.get(concreteService(runtime))?.host
  } catch {
    return undefined
  }
}

export default TuiShortcutRuntime
