/**
 * Built-in keyboard-shortcut keymap: the shared combo grammar, the action
 * registry, and the live override cache behind `/settings` customization.
 *
 * Split of concerns across the input stack:
 * - `dsh-adapter/shortcuts.ts` owns the PLUGIN registry (`ctx.tuiShortcuts`)
 *   and re-exports the grammar from here so both sides parse identically.
 * - This module owns what the TUI itself binds: a fixed set of named actions
 *   (paste, history, editor, …) whose combos resolve as
 *   settings.yaml user layer > cordis.yml `shortcuts` > the registry default.
 * `Chat.tsx` / `PromptInput.tsx` match keypresses against the EFFECTIVE
 * combos via {@link actionMatches} — never against a hardcoded string.
 *
 * The macOS modifier alias mirrors `isMod`: a combo spelled with `ctrl`
 * matches Cmd (`super`) on the mac too, so `ctrl+v` keeps meaning "paste
 * with the platform primary modifier" everywhere. `alt` always means the
 * ink `meta` flag. Shift must match exactly (ctrl+shift+v is the terminal's
 * native paste, never the app's clipboard read).
 */

import { isMac } from './modifiers.js'

/** Minimal structural shape of the ink Key flags the matchers read. */
export interface ComboKeyFlags {
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

/** A parsed `ctrl+shift+p` style combo. */
export interface ParsedCombo {
  readonly raw: string
  readonly ctrl: boolean
  readonly meta: boolean
  readonly shift: boolean
  /** Named key flag on the Key object, or undefined for a character key. */
  readonly named?: keyof ComboKeyFlags
  /** Character to match against the ink `input` string (lowercased). */
  readonly char?: string
}

const NAMED_KEYS: Record<string, keyof ComboKeyFlags> = {
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
 * Parse `ctrl+shift+p` style combos. Returns undefined on anything
 * malformed or disallowed (no ctrl/alt modifier, unknown key name, escape
 * combos — the same grammar the plugin shortcut registry enforces).
 */
export function parseCombo(raw: string): ParsedCombo | undefined {
  const parts = String(raw ?? '')
    .toLowerCase()
    .split('+')
    .map(part => part.trim())
    .filter(part => part !== '')
  if (parts.length === 0) return undefined
  let ctrl = false
  let meta = false
  let shift = false
  let named: keyof ComboKeyFlags | undefined
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
  // Escape is fully owned by the TUI (every Escape arrives with meta set on
  // the input layer), so escape combos can never be unambiguous.
  if (named === 'escape') return undefined
  return { raw: parts.join('+'), ctrl, meta, shift, ...(named === undefined ? {} : { named }), ...(char === undefined ? {} : { char }) }
}

/** Canonical form for dedupe/reserved checks: modifiers sorted, key last. */
export function canonicalCombo(combo: ParsedCombo): string {
  const mods = [combo.ctrl ? 'ctrl' : '', combo.meta ? 'alt' : '', combo.shift ? 'shift' : '']
    .filter(part => part !== '')
    .sort()
  return [...mods, combo.named === undefined ? (combo.char ?? '') : String(combo.named)].join('+')
}

/** Canonicalize a user-spelled combo string (`ctrl+c`); unparseable input
 *  comes back lowercased as-is so reserved sets can still carry entries the
 *  grammar itself refuses (bare escape, tab…). */
export function canonicalComboString(raw: string): string {
  const combo = parseCombo(raw)
  return combo === undefined ? String(raw ?? '').toLowerCase() : canonicalCombo(combo)
}

/**
 * Strict matcher (plugin registry semantics): every modifier flag must equal
 * the combo's. `ctrl` means the ctrl flag only — no platform alias.
 */
export function comboMatchesStrict(combo: ParsedCombo, input: string, key: ComboKeyFlags): boolean {
  if (Boolean(key.ctrl) !== combo.ctrl) return false
  if (Boolean(key.meta) !== combo.meta) return false
  if (key.super) return false
  if (Boolean(key.shift) !== combo.shift) return false
  if (combo.named !== undefined) {
    return key[combo.named] === true
  }
  if (combo.char === undefined) return false
  return input.toLowerCase() === combo.char
}

/**
 * Built-in matcher with the platform primary-modifier alias: `ctrl` combos
 * also accept Cmd (`super`) on macOS (isMod semantics), `alt` maps to the
 * ink `meta` flag. Shift stays exact — ctrl+shift+v must keep meaning the
 * terminal's native paste, never the app's clipboard read.
 *
 * `exactPrimary` actions opt out of the ctrl↔Cmd alias: word-level draft
 * undo must not fire on Cmd+Z, which macOS owns for its own conventions.
 * `platformAlias` is injectable so a Linux CI can assert BOTH polarities
 * (`super+v` still pastes, `super+z` never undoes).
 */
function comboMatchesBuiltin(
  combo: ParsedCombo,
  input: string,
  key: ComboKeyFlags,
  exactPrimary = false,
  platformAlias: boolean = isMac,
): boolean {
  const alias = platformAlias && !exactPrimary
  const primary = key.ctrl === true || (alias && key.super === true)
  if (combo.ctrl !== primary) return false
  if (Boolean(key.meta) !== combo.meta) return false
  if (Boolean(key.shift) !== combo.shift) return false
  if (combo.named !== undefined) {
    return key[combo.named] === true
  }
  if (combo.char === undefined) return false
  return input.toLowerCase() === combo.char
}

/** Identifiers of every customizable built-in action. */
export type ShortcutActionId =
  | 'paste'
  | 'history'
  | 'editor'
  | 'transcript'
  | 'trajectory'
  | 'dashboard'
  | 'contextPanel'
  /** 落地页「继续上次会话」一键（第七版）：只在启动页生效，聊天页不绑。 */
  | 'continue'
  | 'showAll'
  | 'questionFold'
  | 'redraw'
  | 'todoFold'
  | 'expandEditor'
  | 'star'
  | 'undo'
  | 'sidePanel'
  | 'sidePanelZoom'

export interface ShortcutActionSpec {
  readonly id: ShortcutActionId
  /** Default combos; the FIRST entry is the canonical display form. */
  readonly defaults: readonly string[]
  /**
   * Opt out of the macOS ctrl↔Cmd alias for this action: the combo then needs
   * the real ctrl flag. Draft undo uses it so Cmd+Z keeps whatever meaning the
   * rest of macOS gives it.
   */
  readonly exactPrimary?: boolean
}

/**
 * The registry. Defaults encode today's hard-wired bindings — `paste` also
 * carries the `alt+v` alias for terminals that intercept Ctrl+V before the
 * app ever sees the byte (some terminals/IMEs reserve Ctrl+V for their own
 * paste and never forward it in raw mode).
 */
export const SHORTCUT_ACTIONS: readonly ShortcutActionSpec[] = [
  { id: 'paste', defaults: ['ctrl+v', 'alt+v'] },
  { id: 'history', defaults: ['ctrl+r'] },
  { id: 'editor', defaults: ['ctrl+g'] },
  { id: 'transcript', defaults: ['ctrl+o'] },
  { id: 'trajectory', defaults: ['ctrl+t'] },
  { id: 'dashboard', defaults: ['ctrl+a'] },
  { id: 'contextPanel', defaults: ['ctrl+p'] },
  // 落地页 Continue：alt+r（resume 语义）。占用核对（SHORTCUT_ACTIONS defaults ∪
  // FIXED_RESERVED_COMBOS）：ctrl 系 v/r/g/o/t/a/p/e/l/q/k/b/c/d/u/w/j/left/right/return
  // 全占，alt 系只有 v/s/z/return/up 在册——alt+r 空闲，且不与输入框抢字母键。
  { id: 'continue', defaults: ['alt+r'] },
  { id: 'showAll', defaults: ['ctrl+e'] },
  { id: 'redraw', defaults: ['ctrl+l'] },
  { id: 'todoFold', defaults: ['ctrl+q'] },
  { id: 'questionFold', defaults: ['ctrl+k'] },
  { id: 'expandEditor', defaults: ['ctrl+shift+e'] },
  // 开屏标语里的"一键 star"：与 `/star`、弹窗按钮同一个动作（gh api PUT）。
  // 用 alt 组合是为了不跟输入框抢字母键。
  { id: 'star', defaults: ['alt+s'] },
  // Word-level undo for the prompt draft. `exactPrimary` keeps Cmd+Z out of
  // it on macOS; the combo stays remappable through /settings like any other.
  { id: 'undo', defaults: ['ctrl+z'], exactPrimary: true },
  // 侧栏三态开关：关闭 → 打开并聚焦右栏 → 焦点回 Chat → 关闭（VS Code 同
  // 键位；tmux 用户的前缀会吞掉 Ctrl+B，可在 /settings → Shortcuts 重映射）。
  { id: 'sidePanel', defaults: ['ctrl+b'] },
  { id: 'sidePanelZoom', defaults: ['alt+z'] },
]

/** Actions that refuse the macOS ctrl↔Cmd alias (see `exactPrimary`). */
const EXACT_PRIMARY_ACTIONS: ReadonlySet<ShortcutActionId> = new Set(
  SHORTCUT_ACTIONS.filter(action => action.exactPrimary === true).map(action => action.id),
)

const DEFAULT_COMBO_MAP: ReadonlyMap<ShortcutActionId, readonly ParsedCombo[]> = new Map(
  SHORTCUT_ACTIONS.map(action => [action.id, action.defaults.map(parseCombo).filter((combo): combo is ParsedCombo => combo !== undefined)]),
)

/** Live overrides (settings user layer + cordis.yml merged by plugin.ts). */
let overrideMap: ReadonlyMap<ShortcutActionId, readonly ParsedCombo[]> = new Map()

/**
 * Replace the whole override map. Invalid or blank entries are DROPPED
 * (the action keeps its default) — a typo in cordis.yml must never disable
 * a built-in, and the settings field's parse already refuses invalid
 * drafts before anything is written.
 */
export function setKeymapOverrides(overrides: Partial<Record<ShortcutActionId, string | readonly string[] | undefined>>): void {
  const next = new Map<ShortcutActionId, readonly ParsedCombo[]>()
  for (const action of SHORTCUT_ACTIONS) {
    const raw = overrides[action.id]
    if (raw === undefined) continue
    const list = (Array.isArray(raw) ? raw : [raw])
      .flatMap(entry => String(entry).split(/[,;]/))
      .map(entry => entry.trim())
      .filter(entry => entry !== '')
    const parsed = list.map(parseCombo).filter((combo): combo is ParsedCombo => combo !== undefined)
    if (parsed.length === 0) continue
    next.set(action.id, parsed)
  }
  overrideMap = next
}

/** Test seam: drop every override. */
export function resetKeymapOverrides(): void {
  overrideMap = new Map()
}

/** Effective combos for one action (overrides win over defaults). */
export function effectiveCombos(action: ShortcutActionId): readonly ParsedCombo[] {
  return overrideMap.get(action) ?? DEFAULT_COMBO_MAP.get(action) ?? []
}

/** Effective combos as display strings (`ctrl+v, alt+v`). */
export function effectiveComboString(action: ShortcutActionId): string {
  return effectiveCombos(action).map(combo => combo.raw).join(', ')
}

/** First effective combo, lowercase ('ctrl+o'): the inline-hint form, so
 *  hints follow remaps (#1028). */
export function primaryComboString(action: ShortcutActionId): string {
  return effectiveCombos(action)[0]?.raw ?? ''
}

/** Modifier token → display label ('ctrl' → 'Ctrl'). */
const COMBO_MODIFIER_LABELS: Readonly<Record<string, string>> = {
  ctrl: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  meta: 'Meta',
  super: 'Super',
}

/** One combo in display capitalization ('ctrl+k' → 'Ctrl+K'). */
export function comboDisplay(raw: string): string {
  return raw.split('+').map(token => {
    const lower = token.toLowerCase()
    const mod = COMBO_MODIFIER_LABELS[lower]
    if (mod !== undefined) return mod
    return token.length === 1 ? token.toUpperCase() : token[0].toUpperCase() + token.slice(1)
  }).join('+')
}

/** Effective combos as display strings ('Ctrl+K, Alt+V'). */
export function effectiveComboDisplay(action: ShortcutActionId): string {
  return effectiveCombos(action).map(combo => comboDisplay(combo.raw)).join(', ')
}

/** Match a keypress against an action's EFFECTIVE combos (platform alias
 *  included, minus the actions that opted out via `exactPrimary`). This is
 *  the one call site Chat/PromptInput should need. `platformAlias` is a test
 *  seam: a Linux CI passes `true` to assert the macOS polarity. */
export function actionMatches(
  action: ShortcutActionId,
  input: string,
  key: ComboKeyFlags,
  platformAlias: boolean = isMac,
): boolean {
  const combos = effectiveCombos(action)
  const exactPrimary = EXACT_PRIMARY_ACTIONS.has(action)
  for (let index = 0; index < combos.length; index += 1) {
    if (comboMatchesBuiltin(combos[index]!, input, key, exactPrimary, platformAlias)) return true
  }
  return false
}

/**
 * Parse user draft text for a settings field: one or more combos separated
 * by commas/semicolons (spaces around separators tolerated). Empty/blank
 * text means "restore the default" ({ combos: [] }); a malformed token makes
 * the whole draft undefined (invalid — the settings screen blocks the save).
 */
export function parseComboDraft(text: string): { combos: string[] } | undefined {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return { combos: [] }
  const tokens = trimmed
    .split(/[,;]/)
    .map(token => token.trim())
    .filter(token => token !== '')
  if (tokens.length === 0) return { combos: [] }
  const combos: string[] = []
  for (const token of tokens) {
    if (parseCombo(token) === undefined) return undefined
    combos.push(token.toLowerCase())
  }
  return { combos }
}

/**
 * Canonical combos the TUI binds but users canNOT remap — interrupt/exit,
 * the readline-style editor keys, the newline variants, and the navigation
 * keys plugins must never shadow. The customizable action combos (see
 * {@link SHORTCUT_ACTIONS}) join this set dynamically wherever both are
 * consulted. Entries the combo grammar itself refuses (bare escape, tab,
 * shift+tab) stay listed verbatim for the lowercase fallback canonical.
 */
export const FIXED_RESERVED_COMBOS: readonly string[] = [
  'ctrl+c', // interrupt / clear
  'ctrl+d', // exit on empty input
  'ctrl+e', // editor line end (also the showAll action's default)
  'ctrl+a', // editor line start (also the dashboard action's default)
  'ctrl+u', // kill line
  'ctrl+k', // kill to end
  'ctrl+w', // kill word
  'ctrl+j', // newline fallback (legacy LF / extended key reporting)
  'ctrl+left', // word jump
  'ctrl+right', // word jump
  'ctrl+return', // newline (multi-line input)
  'ctrl+shift+return', // shift+Enter newline (CSI 13;6u) — same editor binding
  'alt+return', // newline fallback on terminals without shift reporting
  'alt+up', // pull the last pending message back for editing
  'escape', // pickers / interrupt / rewind double-tap
  'tab', // command completion
  'shift+tab', // session-mode cycle
]

const FIXED_RESERVED_CANONICAL = new Set(FIXED_RESERVED_COMBOS.map(canonicalComboString))

/** The fixed reserved set in canonical form (shared with the adapter registry). */
export function fixedReservedCombos(): ReadonlySet<string> {
  return FIXED_RESERVED_CANONICAL
}

/** Whether a user-spelled combo hits a binding that no remap can free. */
export function isFixedReserved(raw: string): boolean {
  return FIXED_RESERVED_CANONICAL.has(canonicalComboString(raw))
}

/**
 * Draft-time conflict check for the settings fields: a combo is unusable
 * when it is fixed-reserved, or when some OTHER action currently binds it
 * (its own action's defaults are fine to restate). Without this a remap
 * like history → ctrl+v would silently shadow paste at match time.
 */
export function draftComboConflicts(action: ShortcutActionId, combos: readonly string[]): boolean {
  const others = new Set<string>()
  const own = new Set<string>()
  for (const spec of SHORTCUT_ACTIONS) {
    if (spec.id === action) {
      // Restating a combo this action already binds — a default or the
      // current override — changes nothing about what shadows what; it must
      // not read as a conflict. This is what lets dashboard re-save its own
      // ctrl+a default even though that combo is also fixed-reserved for
      // the editor line-start (the dual-use the defaults themselves encode).
      for (const raw of spec.defaults) own.add(canonicalComboString(raw))
      for (const combo of effectiveCombos(spec.id)) own.add(canonicalCombo(combo))
      continue
    }
    for (const combo of effectiveCombos(spec.id)) others.add(canonicalCombo(combo))
  }
  return combos.some(combo => {
    if (own.has(canonicalComboString(combo))) return false
    return isFixedReserved(combo) || others.has(canonicalComboString(combo))
  })
}

/**
 * Canonical combos every customizable action currently binds (defaults ∪
 * overrides) — the `dsh-adapter` plugin registry folds these into its
 * reserved set so a plugin can never shadow a built-in, however the user
 * remapped it.
 */
export function reservedActionCombos(): ReadonlySet<string> {
  const reserved = new Set<string>()
  for (const action of SHORTCUT_ACTIONS) {
    for (const combo of effectiveCombos(action.id)) reserved.add(canonicalCombo(combo))
  }
  return reserved
}
