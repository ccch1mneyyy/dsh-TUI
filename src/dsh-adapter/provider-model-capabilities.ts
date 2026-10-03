import type { ProviderModelCapabilities, ProviderModelEditor } from '../adapter/ports/channel-settings.js'
import type { LlmDiscoveredModel } from '../adapter/ports/channel-view.js'
import { t } from '../i18n.js'
import { installedMeetsVersion } from './contract.js'

export const PROVIDER_REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const MODEL_CAPABILITY_FIELDS = ['contextWindow', 'maxTokens', 'reasoningEfforts', 'input'] as const
export const CATALOG_MODEL_OVERRIDES_AVAILABLE = installedMeetsVersion(
  '@deepseek-ai/dsh-llm-pi-ai',
  '0.2.0-rc.2',
)

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

function capabilitiesOf(entry: Record<string, unknown>): ProviderModelCapabilities {
  const reasoning = entry['reasoningEfforts']
  const input = entry['input']
  return {
    ...(typeof entry['contextWindow'] === 'number' ? { contextWindow: entry['contextWindow'] } : {}),
    ...(typeof entry['maxTokens'] === 'number' ? { maxTokens: entry['maxTokens'] } : {}),
    ...(reasoning === false ? { reasoningEfforts: false as const }
      : reasoning !== null && typeof reasoning === 'object' && !Array.isArray(reasoning)
        ? { reasoningEfforts: Object.fromEntries(Object.entries(reasoning).filter(
          (entry): entry is [string, string | null] => typeof entry[1] === 'string' || entry[1] === null,
        )) }
        : {}),
    ...(Array.isArray(input) && input.length > 0 ? { input: input.filter(
      (value): value is 'text' | 'image' => value === 'text' || value === 'image',
    ) } : {}),
  }
}

/** Stage edits until the surrounding model selection / add confirmation commits. */
export function createProviderModelEditor(
  entryFor: (id: string) => Record<string, unknown>,
  discoveredById: ReadonlyMap<string, LlmDiscoveredModel>,
): { editor: ProviderModelEditor; entries: ReadonlyMap<string, Record<string, unknown>> } {
  const entries = new Map<string, Record<string, unknown>>()
  const editor: ProviderModelEditor = {
    // Older adapters silently discard undeclared profile fields. Keep their
    // other capability controls usable without offering a nonfunctional one.
    reasoningEditable: installedMeetsVersion('@deepseek-ai/dsh-llm-pi-ai', '0.2.0-rc.1'),
    read(id) {
      const discovered = discoveredById.get(id)
      return {
        values: capabilitiesOf(entries.get(id) ?? entryFor(id)),
        defaults: {
          ...(discovered?.contextWindow === undefined ? {} : { contextWindow: discovered.contextWindow }),
          ...(discovered?.maxTokens === undefined ? {} : { maxTokens: discovered.maxTokens }),
          ...(discovered?.inputModalities === undefined ? {} : {
            input: discovered.inputModalities.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image'),
          }),
        },
      }
    },
    save(id, values) {
      for (const count of [values.contextWindow, values.maxTokens]) {
        if (count !== undefined && (!Number.isSafeInteger(count) || count <= 0)) {
          throw new Error(t('provider-model-capacity-invalid'))
        }
      }
      if (values.reasoningEfforts !== undefined && values.reasoningEfforts !== false) {
        if (Object.entries(values.reasoningEfforts).some(([level, wire]) =>
          wire === null ? level !== 'off' : typeof wire !== 'string' || wire.trim().length === 0,
        )) throw new Error(t('provider-model-reasoning-invalid'))
        parseModelReasoning(formatModelReasoning(values.reasoningEfforts))
      }
      if (values.input !== undefined && (values.input.length === 0
        || values.input.some(value => value !== 'text' && value !== 'image'))) {
        throw new Error(t('provider-model-input-invalid'))
      }
      const original = entryFor(id)
      const previous = entries.get(id) ?? original
      const previousValues = capabilitiesOf(previous)
      const next = { ...previous }
      for (const field of MODEL_CAPABILITY_FIELDS) {
        if (JSON.stringify(previousValues[field]) === JSON.stringify(values[field])) continue
        if (field === 'reasoningEfforts' && !editor.reasoningEditable) {
          throw new Error(t('provider-model-reasoning-unavailable'))
        }
        if (values[field] === undefined) delete next[field]
        else next[field] = values[field]
      }
      if (MODEL_CAPABILITY_FIELDS.every(field => JSON.stringify(next[field]) === JSON.stringify(original[field]))) entries.delete(id)
      else entries.set(id, next)
    },
    edited: id => entries.has(id),
  }
  return { editor, entries }
}
