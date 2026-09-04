/**
 * Configurable Shift+Tab session modes (the `modes` dsh-tui plugin config):
 * each mode is a named bundle of optional DSH plane switches — plan mode
 * (dsh-plan-mode `/plan`), sandbox mode (dsh-sandbox-policy `sandbox/mode`
 * session events), approval policy (dsh-user-approval `approval/policy`
 * events), or a durable permission preset identity. An absent atom means
 * "this mode does not touch that plane"; `permission` may be combined with
 * `plan`, but not with `sandbox` or `approval`.
 */
import { t } from './i18n.js'

export interface SessionModeSpec {
  /** Stable id; also the display name unless `label` is set or the id is a
   *  localized built-in (`default`/`plan`/`full`). */
  id: string
  /** Optional display label; wins over the built-in i18n name. */
  label?: string
  /** Plan mode on/off (dsh-plan-mode `/plan`). */
  plan?: boolean
  /** Sandbox mode override (dsh-sandbox-policy `sandbox/mode`). */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Approval policy override (dsh-user-approval `approval/policy`). */
  approval?: 'ask' | 'never'
  /** Durable DSH permission preset identity (`permission/preset`). */
  permission?: string
}

/** The shipped cycle when cordis.yml pins no `modes` — array order IS the
 *  Shift+Tab cycle order; index 0 is the unmarked base mode. */
export const DEFAULT_SESSION_MODES: readonly SessionModeSpec[] = [
  { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
  { id: 'plan', plan: true, sandbox: 'read-only', approval: 'ask' },
  { id: 'full', plan: false, sandbox: 'danger-full-access', approval: 'never' },
]

/** Preset names the TUI treats as the canonical built-ins. They are covered
 *  by the static modes of the default cycle, so they never enter the cycle as
 *  dynamic entries; `/permission` targets them whenever the deployment's
 *  preset table keeps the stock names. */
export const CANONICAL_PERMISSION_PRESETS: ReadonlySet<string> = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access',
])

/** The stock bundle each canonical preset name stands for. */
export const CANONICAL_PERMISSION_BUNDLES: readonly {
  value: string
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  approval: 'ask' | 'never'
}[] = [
  { value: 'read-only', sandbox: 'read-only', approval: 'ask' },
  { value: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' },
  { value: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' },
]

/** One runtime roster entry the deployment exposes (`optionOf` shape). */
export interface PermissionRosterOptionLike {
  readonly value: string
  readonly name: string
  readonly description?: string
}

/** Reserved identity names never treated as switchable presets. */
export const RESERVED_PERMISSION_PRESETS: ReadonlySet<string> = new Set(['custom', 'status'])

/**
 * Resolve the canonical preset for an effective sandbox/approval bundle.
 * When the deployment's preset table is atom-resolving (`extras` non-empty)
 * the FIRST matching table entry wins — stock names behave exactly as
 * before, while renamed/extended tables stay table-driven instead of
 * hard-coding names. Without a resolving table the stock canonical bundles
 * are the fallback (identical behavior on harnesses whose service does not
 * expose preset atoms). Undefined means no visible preset matches.
 */
export function canonicalPresetFor(
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access',
  approval: 'ask' | 'never',
  extras?: readonly { value: string; sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'; approval?: 'ask' | 'never' }[],
): string | undefined {
  if (extras !== undefined && extras.length > 0) {
    const extra = extras.find(entry => entry.sandbox === sandbox && entry.approval === approval)
    if (extra !== undefined) return extra.value
    return undefined
  }
  const stock = CANONICAL_PERMISSION_BUNDLES.find(bundle => bundle.sandbox === sandbox && bundle.approval === approval)
  return stock?.value
}

/**
 * Keep a runtime permission roster stable across refreshes without overriding
 * the registry's order on first observation. Existing identities retain their
 * relative order; newly observed identities follow the latest official order.
 * Removed identities are omitted, so a later re-add is treated as new.
 */
export function stablePermissionRosterOrder(
  previous: readonly string[],
  current: readonly string[],
): readonly string[] {
  const available = new Set(current)
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const value of previous) {
    if (available.has(value) && !seen.has(value)) {
      seen.add(value)
      ordered.push(value)
    }
  }
  for (const value of current) {
    if (!seen.has(value)) {
      seen.add(value)
      ordered.push(value)
    }
  }
  return ordered
}

/**
 * Decide whether one runtime roster option may enter the Shift+Tab cycle.
 * Third-party presets are appended after configured/default modes; reserved
 * sentinels, canonical stock presets (they already ARE the static modes),
 * duplicate identities and unsafe command tokens are excluded with a reason.
 */
export function permissionCycleEntry(
  option: PermissionRosterOptionLike,
  configuredPermissions: ReadonlySet<string>,
): { accepted: true; option: PermissionRosterOptionLike } | { accepted: false; reason: string } {
  if (RESERVED_PERMISSION_PRESETS.has(option.value)) return { accepted: false, reason: 'reserved sentinel' }
  if (CANONICAL_PERMISSION_PRESETS.has(option.value)) return { accepted: false, reason: 'canonical preset' }
  if (configuredPermissions.has(option.value)) return { accepted: false, reason: 'duplicate identity' }
  return { accepted: true, option }
}

/** Config → cycle list: undefined/empty → DEFAULT_SESSION_MODES; entries
 *  declaring no plan/sandbox/approval/permission atom are dropped (their ids
 *  are returned for the caller to warn about). A `permission` atom may be
 *  paired with `plan`, but is mutually exclusive with `sandbox`/`approval`;
 *  conflicting entries are excluded without being reported as dropped (the
 *  caller warns about them separately). If nothing survives,
 *  DEFAULT_SESSION_MODES. Atom vocabularies are already enforced by the
 *  plugin Schema at load, so no value validation happens here. */
export function resolveSessionModes(raw: readonly SessionModeSpec[] | undefined): {
  modes: readonly SessionModeSpec[]
  dropped: readonly string[]
} {
  if (raw === undefined || raw.length === 0) return { modes: DEFAULT_SESSION_MODES, dropped: [] }
  const dropped: string[] = []
  const modes = raw.filter(spec => {
    const hasPermission = spec.permission !== undefined
    const conflicts = hasPermission && (spec.sandbox !== undefined || spec.approval !== undefined)
    const usable = !conflicts && (
      spec.plan !== undefined
      || spec.sandbox !== undefined
      || spec.approval !== undefined
      || hasPermission
    )
    if (!usable && !conflicts) dropped.push(spec.id)
    return usable
  })
  return modes.length === 0 ? { modes: DEFAULT_SESSION_MODES, dropped } : { modes, dropped }
}

/** Display name: explicit `label` > built-in i18n (`mode-default`/
 *  `mode-plan`/`mode-full` for those ids) > the raw id. */
export function modeDisplayName(spec: SessionModeSpec): string {
  if (spec.label !== undefined) return spec.label
  if (spec.id === 'default') return t('mode-default')
  if (spec.id === 'plan') return t('mode-plan')
  if (spec.id === 'full') return t('mode-full')
  return spec.id
}
