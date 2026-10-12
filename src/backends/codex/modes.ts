/**
 * The Codex permission presets as the backend's modes
 * (docs/codex-backend-design.md §5.9; C0 V8: the official `/permissions`
 * presets `read-only` "Read Only", `auto` "Default", `full-access` "Full
 * Access", plus Plan mode, which C2 adds as a collaboration mode).
 *
 * `auto` is the base mode a session starts in unless the user picked
 * another: on-request approvals inside a workspace-write sandbox, so every
 * command or edit outside the workspace asks first.
 */
import { rec, str } from './narrow.js'

/** The permission modes (Plan mode is C2). */
export const CODEX_MODE_IDS = ['read-only', 'auto', 'full-access'] as const
export type CodexModeId = typeof CODEX_MODE_IDS[number]

/** The mode a session starts in when nothing is remembered. */
export const DEFAULT_CODEX_MODE: CodexModeId = 'auto'

/** What each mode sends: `thread/start`/`thread/resume` take a sandbox
 *  mode; `turn/start` and `thread/settings/update` a sandbox policy. */
export const CODEX_MODE_PARAMS: Readonly<Record<CodexModeId, { readonly approvalPolicy: 'on-request' | 'never'; readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access' }>> = {
  'read-only': { approvalPolicy: 'on-request', sandbox: 'read-only' },
  auto: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  'full-access': { approvalPolicy: 'never', sandbox: 'danger-full-access' },
}

export function isCodexModeId(value: unknown): value is CodexModeId {
  return typeof value === 'string' && (CODEX_MODE_IDS as readonly string[]).includes(value)
}

/** The sandbox mode a `SandboxPolicy` object (or mode string) names. */
function sandboxModeOf(sandbox: unknown): string | undefined {
  const text = str(sandbox)
  if (text !== undefined) return text
  switch (str(rec(sandbox)?.type)) {
    case 'readOnly': return 'read-only'
    case 'workspaceWrite': return 'workspace-write'
    case 'dangerFullAccess': return 'danger-full-access'
    default: return undefined
  }
}

/** The mode a thread's reported settings correspond to; `custom` when they
 *  match no preset (a user config the presets do not cover). */
export function modeIdOf(approvalPolicy: unknown, sandbox: unknown): CodexModeId | 'custom' {
  const approval = str(approvalPolicy)
  const mode = sandboxModeOf(sandbox)
  for (const id of CODEX_MODE_IDS) {
    const params = CODEX_MODE_PARAMS[id]
    if (params.approvalPolicy === approval && params.sandbox === mode) return id
  }
  return 'custom'
}
