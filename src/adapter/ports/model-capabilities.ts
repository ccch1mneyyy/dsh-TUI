/**
 * Provider model-capability parsing/formatting: the pure port surface the
 * TUI's model editor consumes. Lives in ports/ (not dsh-adapter/) because UI
 * layers may only import TYPES from src/dsh-adapter/ — these helpers are
 * values. Validation errors are raised in the user's language (t()) since
 * the editor surfaces them verbatim; the first i18n use in ports/, kept
 * because error copy is part of this port's contract.
 */
import { t } from '../../i18n.js'
import type { ProviderModelCapabilities } from './channel-settings.js'

export const PROVIDER_REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const MODEL_CAPABILITY_FIELDS = ['contextWindow', 'maxTokens', 'reasoningEfforts', 'input'] as const

/** Empty restores inheritance; K/M are decimal token-count suffixes. */
export function parseModelCapacity(text: string): number | undefined {
  const value = text.trim()
  if (value === '') return undefined
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(value)
  const count = match === null ? NaN : Number(match[1]) * (match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2] ? 1000 : 1)
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error(t('provider-model-capacity-invalid'))
  return count
}

/** Editable level list, including explicit wire aliases and off-by-omission. */
export function formatModelReasoning(value: ProviderModelCapabilities['reasoningEfforts']): string {
  if (value === undefined) return ''
  if (value === false) return 'none'
  return Object.entries(value).map(([level, wire]) =>
    wire === null || (wire === level && level !== 'off') ? level : `${level}=${wire}`,
  ).join(', ')
}

/** Decode offered levels, not the current conversation's selected effort. */
export function parseModelReasoning(text: string): ProviderModelCapabilities['reasoningEfforts'] {
  const value = text.trim()
  if (value === '') return undefined
  if (value.toLowerCase() === 'none' || value.toLowerCase() === 'false') return false
  const entries = value.split(',').map(part => {
    const [rawLevel, ...rest] = part.trim().split('=')
    const level = rawLevel.toLowerCase()
    const wire = rest.length === 0 ? (level === 'off' ? null : level) : rest.join('=').trim()
    return [level, wire] as const
  })
  if (entries.some(([level, wire]) => !PROVIDER_REASONING_LEVELS.some(id => id === level)
      || (wire !== null && wire.length === 0))
    || new Set(entries.map(([level]) => level)).size !== entries.length
    || !entries.some(([level]) => level !== 'off')) {
    throw new Error(t('provider-model-reasoning-invalid'))
  }
  return Object.fromEntries(entries)
}
