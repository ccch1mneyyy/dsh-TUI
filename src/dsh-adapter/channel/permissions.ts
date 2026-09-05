import { type SessionEvent } from '@deepseek-ai/dsh-session'
import { t } from '../../i18n.js'
import { type SessionModeSpec } from '../../sessionModes.js'
import { cleanRenderText } from '../sanitize.js'
import type { PermissionPresetOption, PermissionPresetService, PermissionPresetSnapshot } from './types.js'

export const PERMISSION_PRESET_CUSTOM = 'custom'

export const PERMISSION_PRESET_NAME_CELLS = 120

export const PERMISSION_PRESET_DESCRIPTION_CELLS = 400

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

export function legacyPermissionPresetOptions(): readonly PermissionPresetOption[] {
  return [
    {
      value: 'read-only',
      name: t('permission-preset-readonly'),
      description: t('permission-preset-readonly-desc'),
    },
    {
      value: 'workspace-write',
      name: t('permission-preset-workspace-write'),
      description: t('permission-preset-workspace-write-desc'),
    },
    {
      value: 'danger-full-access',
      name: t('permission-preset-full-access'),
      description: t('permission-preset-full-access-desc'),
    },
  ]
}

export function legacyPermissionPresetSnapshot(sandbox: SessionModeSpec['sandbox']): PermissionPresetSnapshot {
  const options = legacyPermissionPresetOptions()
  const currentOption = sandbox === undefined ? undefined : options.find(option => option.value === sandbox)
  return {
    availability: 'legacy',
    options,
    ...(currentOption === undefined
      ? {}
      : { current: { ...currentOption, kind: 'preset' as const } }),
  }
}

export function unavailablePermissionPresetSnapshot(): PermissionPresetSnapshot {
  return { availability: 'unavailable', options: [] }
}

export function normalizePermissionPresetOption(value: unknown): PermissionPresetOption | undefined {
  if (!isRecord(value) || typeof value.value !== 'string' || typeof value.name !== 'string') return undefined
  const name = cleanRenderText(value.name, PERMISSION_PRESET_NAME_CELLS)
  if (name === '') return undefined
  if (value.description !== undefined && typeof value.description !== 'string') return undefined
  const description = value.description === undefined
    ? undefined
    : cleanRenderText(value.description, PERMISSION_PRESET_DESCRIPTION_CELLS)
  if (value.description !== undefined && description === '') return undefined
  return {
    value: value.value,
    name,
    ...(description === undefined || description === '' ? {} : { description }),
  }
}

export function permissionPresetSnapshotFromService(
  service: unknown,
  events: readonly SessionEvent[],
): PermissionPresetSnapshot {
  if (!isRecord(service)) return unavailablePermissionPresetSnapshot()
  const runtime = service as PermissionPresetService
  try {
    const capturedNames = runtime.names
    const current = runtime.current
    const optionOf = runtime.optionOf
    if (!Array.isArray(capturedNames) || capturedNames.length === 0) return unavailablePermissionPresetSnapshot()
    if (typeof current !== 'function' || typeof optionOf !== 'function') return unavailablePermissionPresetSnapshot()

    const names = [...capturedNames]
    const seen = new Set<string>()
    for (const name of names) {
      if (typeof name !== 'string' || name.trim() === '' || name === PERMISSION_PRESET_CUSTOM || seen.has(name)) {
        return unavailablePermissionPresetSnapshot()
      }
      seen.add(name)
    }

    const options: PermissionPresetOption[] = []
    for (const name of names) {
      const option = normalizePermissionPresetOption(optionOf(name))
      if (option === undefined || option.value !== name) return unavailablePermissionPresetSnapshot()
      options.push({ ...option })
    }

    const currentValue = current(events)
    if (typeof currentValue !== 'string' || (currentValue !== PERMISSION_PRESET_CUSTOM && !seen.has(currentValue))) {
      return unavailablePermissionPresetSnapshot()
    }
    const currentOption = normalizePermissionPresetOption(optionOf(currentValue))
    if (currentOption === undefined || currentOption.value !== currentValue) return unavailablePermissionPresetSnapshot()
    if (currentValue !== PERMISSION_PRESET_CUSTOM) {
      const rosterOption = options.find(option => option.value === currentValue)
      if (
        rosterOption === undefined
        || rosterOption.name !== currentOption.name
        || rosterOption.description !== currentOption.description
      ) {
        return unavailablePermissionPresetSnapshot()
      }
    }

    return {
      availability: 'runtime',
      options,
      current: {
        ...currentOption,
        kind: currentValue === PERMISSION_PRESET_CUSTOM ? 'custom' : 'preset',
      },
    }
  } catch {
    return unavailablePermissionPresetSnapshot()
  }
}
