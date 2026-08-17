import { isMac } from './utils/modifiers.js'

export interface KeybindingConfig {
  historySearch?: string
  toggleDetails?: string
  interrupt?: string
}

export interface KeypressModifiers {
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  super?: boolean
}

interface ParsedKeybinding {
  readonly canonical: string
  readonly key: string
  readonly ctrl: boolean
  readonly meta: boolean
  readonly shift: boolean
  readonly super: boolean
  readonly primary: boolean
}

export const DEFAULT_KEYBINDINGS = {
  historySearch: 'mod+r',
  toggleDetails: 'mod+o',
  interrupt: 'ctrl+c',
} as const

export type KeybindingAction = keyof typeof DEFAULT_KEYBINDINGS

export interface KeybindingWarning {
  readonly action: KeybindingAction
  readonly value: string
  readonly reason: 'invalid' | 'conflict'
  readonly conflictWith?: KeybindingAction
}

export interface KeybindingResolution {
  readonly bindings: Record<KeybindingAction, string>
  readonly warnings: readonly KeybindingWarning[]
}

function parseKeybinding(value: string): ParsedKeybinding | undefined {
  const parts = value.trim().toLowerCase().split('+').map(part => part.trim())
  const key = parts.pop()
  if (!key || !/^[a-z0-9]$/u.test(key)) return undefined

  const modifiers = new Set(parts)
  if (modifiers.size !== parts.length) return undefined
  if (![...modifiers].every(part => ['alt', 'ctrl', 'mod', 'shift'].includes(part))) return undefined
  if (!modifiers.has('alt') && !modifiers.has('ctrl') && !modifiers.has('mod')) return undefined
  if (modifiers.has('mod') && modifiers.has('ctrl')) return undefined

  const canonical = [
    modifiers.has('mod') ? 'mod' : undefined,
    modifiers.has('ctrl') ? 'ctrl' : undefined,
    modifiers.has('alt') ? 'alt' : undefined,
    modifiers.has('shift') ? 'shift' : undefined,
    key,
  ].filter(Boolean).join('+')

  return {
    canonical,
    key,
    ctrl: modifiers.has('ctrl'),
    meta: modifiers.has('alt'),
    shift: modifiers.has('shift'),
    super: false,
    primary: modifiers.has('mod'),
  }
}

function keybindingsConflict(leftValue: string, rightValue: string): boolean {
  const left = parseKeybinding(leftValue)!
  const right = parseKeybinding(rightValue)!
  if (left.key !== right.key || left.meta !== right.meta || left.shift !== right.shift) return false
  const variants = (binding: ParsedKeybinding): Array<{ ctrl: boolean; super: boolean }> =>
    binding.primary
      ? [{ ctrl: true, super: false }, ...(isMac ? [{ ctrl: false, super: true }] : [])]
      : [{ ctrl: binding.ctrl, super: false }]
  const leftVariants = variants(left)
  const rightVariants = variants(right)
  return leftVariants.some(leftVariant => rightVariants.some(rightVariant =>
    leftVariant.ctrl === rightVariant.ctrl && leftVariant.super === rightVariant.super,
  ))
}

export function resolveKeybindings(config: KeybindingConfig | undefined): KeybindingResolution {
  const bindings: Record<KeybindingAction, string> = { ...DEFAULT_KEYBINDINGS }
  const warnings: KeybindingWarning[] = []
  const validCustom = new Set<KeybindingAction>()
  const actions = Object.keys(DEFAULT_KEYBINDINGS) as KeybindingAction[]
  for (const action of actions) {
    const value = config?.[action]
    if (value === undefined) continue
    const parsed = parseKeybinding(value)
    if (parsed === undefined) {
      warnings.push({ action, value, reason: 'invalid' })
      continue
    }
    bindings[action] = parsed.canonical
    validCustom.add(action)
  }

  while (validCustom.size > 0) {
    const conflicts = new Map<KeybindingAction, KeybindingAction>()
    for (let leftIndex = 0; leftIndex < actions.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < actions.length; rightIndex++) {
        const left = actions[leftIndex]!
        const right = actions[rightIndex]!
        if (!keybindingsConflict(bindings[left], bindings[right])) continue
        if (validCustom.has(left) && !conflicts.has(left)) conflicts.set(left, right)
        if (validCustom.has(right) && !conflicts.has(right)) conflicts.set(right, left)
      }
    }
    if (conflicts.size === 0) break
    for (const [action, conflictWith] of conflicts) {
      const value = config?.[action]
      if (value === undefined) continue
      warnings.push({
        action,
        value,
        reason: 'conflict',
        conflictWith,
      })
      bindings[action] = DEFAULT_KEYBINDINGS[action]
      validCustom.delete(action)
    }
  }
  return { bindings, warnings }
}

export function keybindingLabel(value: string): string {
  const binding = parseKeybinding(value)
  if (binding === undefined) return value
  const modifiers = [
    binding.primary ? (isMac ? '⌘' : 'ctrl') : undefined,
    binding.ctrl ? 'ctrl' : undefined,
    binding.meta ? 'alt' : undefined,
    binding.shift ? 'shift' : undefined,
  ].filter((part): part is string => part !== undefined)
  if (isMac && modifiers[0] === '⌘') {
    return `⌘${[...modifiers.slice(1), binding.key].join('+')}`
  }
  return [...modifiers, binding.key].join('+')
}

export function matchesKeybinding(
  configured: string | undefined,
  fallback: string,
  input: string,
  key: KeypressModifiers,
): boolean {
  const binding = parseKeybinding(configured ?? fallback) ?? parseKeybinding(fallback)!
  const primary = binding.primary && (key.ctrl === true || (isMac && key.super === true))
  const ctrl = binding.primary ? primary : key.ctrl === binding.ctrl
  const superKey = binding.primary ? primary : key.super === binding.super
  return input.toLowerCase() === binding.key
    && ctrl
    && key.meta === binding.meta
    && key.shift === binding.shift
    && superKey
}
