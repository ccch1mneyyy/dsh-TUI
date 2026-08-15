/**
 * Configurable Shift+Tab session modes (the `modes` dsh-tui plugin config):
 * each mode is a named bundle of optional DSH plane switches — plan mode
 * (dsh-plan-mode `/plan`), sandbox mode (dsh-sandbox-policy `sandbox/mode`
 * session events), approval policy (dsh-user-approval `approval/policy`
 * events). An absent atom means "this mode does not touch that plane".
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
}

/** The shipped cycle when cordis.yml pins no `modes` — array order IS the
 *  Shift+Tab cycle order; index 0 is the unmarked base mode. */
export const DEFAULT_SESSION_MODES: readonly SessionModeSpec[] = [
  { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
  { id: 'plan', plan: true, sandbox: 'read-only', approval: 'ask' },
  { id: 'full', plan: false, sandbox: 'danger-full-access', approval: 'never' },
]

/** Config → cycle list: undefined/empty → DEFAULT_SESSION_MODES; entries
 *  declaring no atom at all are dropped (their ids are returned for the
 *  caller to warn about); if nothing survives, DEFAULT_SESSION_MODES. Atom
 *  vocabularies are already enforced by the plugin Schema at load, so no
 *  value validation happens here. */
export function resolveSessionModes(raw: readonly SessionModeSpec[] | undefined): {
  modes: readonly SessionModeSpec[]
  dropped: readonly string[]
} {
  if (raw === undefined || raw.length === 0) return { modes: DEFAULT_SESSION_MODES, dropped: [] }
  const dropped: string[] = []
  const modes = raw.filter(spec => {
    const usable = spec.plan !== undefined || spec.sandbox !== undefined || spec.approval !== undefined
    if (!usable) dropped.push(spec.id)
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
