import { t } from '../../i18n.js'
import { type SessionModeSpec } from '../../sessionModes.js'
import { cleanRenderText } from '../sanitize.js'
import type { PermissionPresetOption, PermissionPresetService, PermissionPresetSnapshot } from './types.js'

export const PERMISSION_PRESET_CUSTOM = 'custom'

export const PERMISSION_PRESET_NAME_CELLS = 120

export const PERMISSION_PRESET_DESCRIPTION_CELLS = 400

/** The mounted registry may expose seams this package's declared contract
 *  does not name yet: `resolve` (atom bundles) and `set` (the write path the
 *  official `/permission` command drives). Read structurally, never assumed. */
export interface PermissionPresetRuntime extends PermissionPresetService {
  resolve?: (name: string) => unknown
  set?: (subject: unknown, name: string) => unknown
}

/** One runtime preset's resolved atom bundle. */
export interface PermissionPresetBundle {
  readonly value: string
  readonly sandbox?: SessionModeSpec['sandbox']
  readonly approval?: SessionModeSpec['approval']
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/** Narrow a raw service read to the structural registry surface. */
export function permissionPresetRuntime(service: unknown): PermissionPresetRuntime | undefined {
  return isRecord(service) ? service as PermissionPresetRuntime : undefined
}

/** Keep a permission roster read-only after it crosses the adapter boundary.
 *  The registry may reuse and mutate its option objects between reads; callers
 *  must observe one stable snapshot instead of a live view into that service. */
export function freezePermissionPresetSnapshot(snapshot: PermissionPresetSnapshot): PermissionPresetSnapshot {
  const options = Object.freeze(snapshot.options.map(option => Object.freeze({ ...option })))
  const current = snapshot.current === undefined ? undefined : Object.freeze({ ...snapshot.current })
  return Object.freeze({
    availability: snapshot.availability,
    options,
    ...(current === undefined ? {} : { current }),
  })
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
  return freezePermissionPresetSnapshot({
    availability: 'legacy',
    options,
    ...(currentOption === undefined
      ? {}
      : { current: { ...currentOption, kind: 'preset' as const } }),
  })
}

export function unavailablePermissionPresetSnapshot(): PermissionPresetSnapshot {
  return freezePermissionPresetSnapshot({ availability: 'unavailable', options: [] })
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

/** Atom bundles the deployment's preset table resolves (value →
 *  sandbox/approval). Empty when the service is absent or exposes no
 *  `resolve` seam — canonical resolution then falls back to the stock
 *  bundles (see `canonicalPresetFor`). */
export function permissionBundlesFromService(service: unknown): readonly PermissionPresetBundle[] {
  const runtime = permissionPresetRuntime(service)
  const resolve = runtime?.resolve
  if (typeof resolve !== 'function') return []
  const names: readonly unknown[] = Array.isArray(runtime?.names) ? runtime.names : []
  const bundles: PermissionPresetBundle[] = []
  for (const name of names) {
    if (typeof name !== 'string') continue
    try {
      const spec = resolve(name)
      if (!isRecord(spec)) continue
      const sandbox = spec.sandbox
      const approval = spec.approval
      if (
        (sandbox === 'read-only' || sandbox === 'workspace-write' || sandbox === 'danger-full-access')
        && (approval === 'ask' || approval === 'never')
      ) {
        bundles.push({ value: name, sandbox, approval })
      }
    } catch {
      // Optional resolution; a broken entry just does not extend the table.
    }
  }
  return bundles
}

/** The registry's current readback for one subject. Real harness registries
 *  resolve `current(session)` through their session-projections seam; earlier
 *  contract versions folded a raw event log. Try the subject as given, then
 *  the event-log shape it may carry. */
export function permissionPresetSnapshotFromService(
  service: unknown,
  subject: unknown,
): PermissionPresetSnapshot {
  const runtime = permissionPresetRuntime(service)
  if (runtime === undefined) return unavailablePermissionPresetSnapshot()
  try {
    const capturedNames: readonly unknown[] = Array.isArray(runtime.names) ? runtime.names : []
    const current = runtime.current as ((subject: unknown) => unknown) | undefined
    const optionOf = runtime.optionOf
    if (capturedNames.length === 0) return unavailablePermissionPresetSnapshot()
    if (typeof current !== 'function' || typeof optionOf !== 'function') return unavailablePermissionPresetSnapshot()

    const names: string[] = []
    for (const name of capturedNames) {
      if (typeof name !== 'string' || name.trim() === '' || name === PERMISSION_PRESET_CUSTOM || names.includes(name)) {
        return unavailablePermissionPresetSnapshot()
      }
      names.push(name)
    }
    const seen = new Set(names)

    const options: PermissionPresetOption[] = []
    for (const name of names) {
      const option = normalizePermissionPresetOption(optionOf(name))
      if (option === undefined || option.value !== name) return unavailablePermissionPresetSnapshot()
      options.push({ ...option })
    }

    let currentValue: unknown
    try {
      currentValue = current(subject)
    } catch {
      currentValue = undefined
    }
    if (typeof currentValue !== 'string') {
      // Second chance for the other contract shape: a subject that carries an
      // event log, or a raw log handed in directly.
      const fallback = (subject as { events?: unknown } | null)?.events ?? subject
      try {
        currentValue = current(fallback)
      } catch {
        if (typeof currentValue !== 'string') return unavailablePermissionPresetSnapshot()
      }
    }
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

    return freezePermissionPresetSnapshot({
      availability: 'runtime',
      options,
      current: {
        ...currentOption,
        kind: currentValue === PERMISSION_PRESET_CUSTOM ? 'custom' : 'preset',
      },
    })
  } catch {
    return unavailablePermissionPresetSnapshot()
  }
}
