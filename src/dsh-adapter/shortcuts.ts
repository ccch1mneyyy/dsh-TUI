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
 * - A RESERVED list (every combo the TUI itself binds globally or in the
 *   prompt editor) is refused at registration with a warning. The list is
 *   the enforcement of "locals win": collisions can never reach the matcher.
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

/** Minimal shape of the ink Key flags the matcher reads (kept structurally
 *  compatible with `Key` from the ui kit without importing React-facing
 *  modules into the adapter). */
export interface TuiShortcutKey {
  ctrl?: boolean
  meta?: boolean
  super?: boolean
  shift?: boolean
  return?: boolean
  escape?: boolean
  tab?: boolean
  backspace?: boolean
  delete?: boolean
  upArrow?: boolean
  downArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  home?: boolean
  end?: boolean
  pageUp?: boolean
  pageDown?: boolean
}

/** Controls that only the Chat input path may use. They are kept out of the
 * Cordis service object, so one plugin cannot synthesize an input event to
 * invoke another plugin's shortcut handler. */
export interface TuiShortcutHost {
  dispatch(input: string, key: TuiShortcutKey): boolean
  setErrorHandler(handler: (combo: string, error: unknown) => void): () => void
}

export interface TuiShortcutOptions {
  /** One-line description (shown by future /help surfaces; required so
   *  every binding is discoverable). */
  description: string
  handler: () => void | Promise<void>
}

interface ParsedCombo {
  readonly raw: string
  readonly ctrl: boolean
  readonly meta: boolean
  readonly shift: boolean
  /** Named key flag on the Key object, or undefined for a character key. */
  readonly named?: keyof TuiShortcutKey
  /** Character to match against the ink `input` string (lowercased). */
  readonly char?: string
}

interface RegisteredShortcut {
  readonly combo: ParsedCombo
  readonly description: string
  readonly handler: () => void | Promise<void>
}

const NAMED_KEYS: Record<string, keyof TuiShortcutKey> = {
  enter: 'return',
  return: 'return',
  esc: 'escape',
  escape: 'escape',
  tab: 'tab',
  backspace: 'backspace',
  delete: 'delete',
  up: 'upArrow',
  down: 'downArrow',
  left: 'leftArrow',
  right: 'rightArrow',
  home: 'home',
  end: 'end',
  pageup: 'pageUp',
  pagedown: 'pageDown',
}

/**
 * Combos the TUI owns, globally or inside the prompt editor (the editor's
 * bindings are checked AFTER plugin shortcuts, so refusing them here is
 * what keeps "locals win" true). Built-in handlers match a MODIFIER SUBSET
 * (`isMod(key) && input === 'x'` — they never exclude an extra Shift), so
 * the reserved check below refuses a plugin combo whose SHIFTLESS form is
 * reserved: ctrl+shift+x would shadow Ctrl+X on terminals that report both
 * as the same keypress (ConPTY does), and would be dead weight on terminals
 * that don't.
 */
const RESERVED_COMBOS = new Set([
  'ctrl+c', // interrupt / clear
  'ctrl+d', // exit on empty input
  'ctrl+t', // startup context panel
  'ctrl+r', // history search
  'ctrl+x', // external editor
  'ctrl+o', // transcript mode toggle
  'ctrl+l', // terminal redraw
  'ctrl+e', // show all messages / line end
  'ctrl+v', // paste
  'ctrl+a', // line start
  'ctrl+u', // kill line
  'ctrl+k', // kill to end
  'ctrl+w', // kill word
  'ctrl+left', // word jump
  'ctrl+right', // word jump
  'ctrl+return', // newline (multi-line input)
  'ctrl+shift+return', // shift+Enter newline (CSI 13;6u) — same editor binding
  'alt+return', // newline fallback on terminals without shift reporting
  'alt+up', // pull the last pending message back for editing
  'escape', // pickers / interrupt / rewind double-tap
  'tab', // command completion
  'shift+tab', // session-mode cycle
])

/**
 * Parse `ctrl+shift+p` style combos. Returns undefined on anything
 * malformed or disallowed (no modifier, unknown key name); `allowReserved`
 * is exposed for tests only.
 */
export function parseShortcutCombo(raw: string): ParsedCombo | undefined {
  const parts = String(raw ?? '')
    .toLowerCase()
    .split('+')
    .map(part => part.trim())
    .filter(part => part !== '')
  if (parts.length === 0) return undefined
  let ctrl = false
  let meta = false
  let shift = false
  let named: keyof TuiShortcutKey | undefined
  let char: string | undefined
  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') {
      if (ctrl) return undefined
      ctrl = true
    } else if (part === 'alt' || part === 'meta' || part === 'option') {
      if (meta) return undefined
      meta = true
    } else if (part === 'shift') {
      if (shift) return undefined
      shift = true
    } else if (part === 'space') {
      if (char !== undefined || named !== undefined) return undefined
      char = ' '
    } else if (part in NAMED_KEYS) {
      if (char !== undefined || named !== undefined) return undefined
      named = NAMED_KEYS[part]
    } else if ([...part].length === 1) {
      if (char !== undefined || named !== undefined) return undefined
      char = part
    } else {
      return undefined
    }
  }
  if (char === undefined && named === undefined) return undefined
  // Bare keys are typing/navigation; a modifier is what makes a shortcut.
  if (!ctrl && !meta) return undefined
  // Escape combos are refused outright: the input layer sets key.meta = true
  // for EVERY Escape (ink/events/input-event.ts — `keypress.meta ||
  // keypress.name === 'escape' || keypress.option`), so an alt+escape combo
  // would match every bare Esc press and shadow clear-input / the double-Esc
  // rewind. Esc is fully owned by the TUI; there is no unambiguous way to
  // bind it.
  if (named === 'escape') return undefined
  return { raw: parts.join('+'), ctrl, meta, shift, ...(named === undefined ? {} : { named }), ...(char === undefined ? {} : { char }) }
}

/** Canonical form for dedupe/reserved checks: modifiers sorted, key last. */
function comboKey(combo: ParsedCombo): string {
  const mods = [combo.ctrl ? 'ctrl' : '', combo.meta ? 'alt' : '', combo.shift ? 'shift' : '']
    .filter(part => part !== '')
    .sort()
  return [...mods, combo.named === undefined ? (combo.char ?? '') : String(combo.named)].join('+')
}

/** Reserved lookup accepts user-spelled combos too (`ctrl+c`). */
function reservedKey(raw: string): string {
  const combo = parseShortcutCombo(raw)
  return combo === undefined ? raw.toLowerCase() : comboKey(combo)
}

const RESERVED_CANONICAL = new Set([...RESERVED_COMBOS].map(reservedKey))

/** Match a keypress against a parsed combo. `input` is ink's input string
 *  (already the resolved character; ctrl+space arrives as ' '). */
export function matchShortcut(combo: ParsedCombo, input: string, key: TuiShortcutKey): boolean {
  if (Boolean(key.ctrl) !== combo.ctrl) return false
  // ink reports Alt as meta; Esc itself also sets meta, which is why the
  // modifier check runs against the combo, not a bare flag read.
  if (Boolean(key.meta) !== combo.meta) return false
  if (key.super) return false
  // Shift must match for NAMED keys exactly as for characters — otherwise a
  // registered ctrl+shift+enter would also match a plain ctrl+enter press,
  // letting a plugin shadow the editor's built-in Ctrl+Enter delivery.
  if (Boolean(key.shift) !== combo.shift) return false
  if (combo.named !== undefined) {
    return key[combo.named] === true
  }
  if (combo.char === undefined) return false
  // Shift+letter arrives as the uppercase character; compare case-folded
  // (the shift FLAG equality above already pinned the modifier state).
  return input.toLowerCase() === combo.char
}

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
    const key = comboKey(parsed)
    // Built-ins match a modifier subset (see RESERVED_COMBOS): a combo whose
    // SHIFTLESS form is reserved collides with the built-in on terminals that
    // don't report Shift distinctly, so it is refused too. The exact form is
    // still checked for combos reserved WITH shift (ctrl+shift+return).
    const shiftlessKey = comboKey({ ...parsed, shift: false })
    if (RESERVED_CANONICAL.has(key) || RESERVED_CANONICAL.has(shiftlessKey)) {
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

  /** Registered combos with descriptions (diagnostics / future /help). */
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
