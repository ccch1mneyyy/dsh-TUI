import type { ProviderModelCapabilities, ProviderModelEditor } from '../adapter/ports/channel-settings.js'
import type { LlmDiscoveredModel } from '../adapter/ports/channel-view.js'
import { t } from '../i18n.js'
import { installedMeetsVersion } from './contract.js'
import { MODEL_CAPABILITY_FIELDS, formatModelReasoning, parseModelReasoning } from '../adapter/ports/model-capabilities.js'

// The pure parsing/formatting surface lives in ports (UI layers may import
// values from there, not from here); re-exported so the wizard's existing
// imports keep working.
export { MODEL_CAPABILITY_FIELDS, PROVIDER_REASONING_LEVELS, formatModelReasoning, parseModelCapacity, parseModelReasoning } from '../adapter/ports/model-capabilities.js'
export const CATALOG_MODEL_OVERRIDES_AVAILABLE = installedMeetsVersion(
  '@deepseek-ai/dsh-llm-pi-ai',
  '0.2.0-rc.2',
)

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
