import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isCommandCompletionToken } from '../../commands.js'
import { snapshotLiveSessionEvents } from '../compat/liveSession.js'
import { t } from '../../i18n.js'
import { modeDisplayName, type SessionModeSpec } from '../../sessionModes.js'
import { PERMISSION_PRESET_CUSTOM, permissionPresetRuntime } from './permissions.js'
import type { PermissionModeRoster } from './mode-roster.js'
import type { ChannelState } from './types.js'

/** Last durable permission preset identity (`permission/preset`), if any.
 *  Registered by the harness permission preset service, never manufactured
 *  by the TUI. */
export function foldPermissionPreset(events: readonly SessionEvent[]): string | undefined {
  let preset: string | undefined
  for (const event of events) {
    if ((event as { type: string }).type === 'permission/preset') {
      const value = (event.data as unknown as { preset?: string }).preset
      if (typeof value === 'string') preset = value
    }
  }
  return preset
}

/** Effective sandbox of a mode target: its explicit atom, else the folded
 *  session value, else the sandbox-policy service default. Unknown means the
 *  bundle is not safely mappable. */
export function effectiveSandboxForMode(
  ctx: Context,
  spec: SessionModeSpec,
  events: readonly SessionEvent[],
): SessionModeSpec['sandbox'] | undefined {
  if (spec.sandbox !== undefined) return spec.sandbox
  let folded: unknown
  for (const event of events) {
    if ((event as { type: string }).type === 'sandbox/mode') {
      folded = (event.data as unknown as { mode?: unknown }).mode
    }
  }
  if (folded === 'read-only' || folded === 'workspace-write' || folded === 'danger-full-access') return folded
  try {
    const sandbox = ctx.get('sandboxPolicy') as { defaultMode?: unknown } | undefined
    const value = sandbox?.defaultMode
    if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') return value
  } catch {
    // Optional service; an unknown default means the target is not safely
    // mappable.
  }
  return undefined
}

/** Effective approval policy of a mode target: its explicit atom, else the
 *  folded session value, else the approval service configuration. */
export function effectiveApprovalForMode(
  ctx: Context,
  spec: SessionModeSpec,
  session: Agent['session'],
): SessionModeSpec['approval'] | undefined {
  if (spec.approval !== undefined) return spec.approval
  let folded: unknown
  for (const event of snapshotLiveSessionEvents(session)) {
    if ((event as { type: string }).type === 'approval/policy') {
      folded = (event.data as unknown as { policy?: unknown }).policy
    }
  }
  if (folded === 'ask' || folded === 'never') return folded
  try {
    const approval = ctx.get('approval') as
      | { effectivePolicy?(session: Agent['session']): unknown; config?: { policy?: unknown } }
      | undefined
    const value = approval?.effectivePolicy?.(session) ?? approval?.config?.policy
    if (value === 'ask' || value === 'never') return value
  } catch {
    // Optional service; an unknown default means the target is not safely
    // mappable.
  }
  return undefined
}

/** Durable permission identity operations for one channel. */
export interface PermissionIdentity {
  /** Folded durable identity of one session log. */
  foldPermissionPreset(session: Agent['session']): string | undefined
  /** Canonical preset for a mode's effective sandbox/approval bundle, when
   *  the deployment's runtime table (or the stock built-ins) has one. */
  canonicalPermissionForMode(spec: SessionModeSpec, session: Agent['session']): string | undefined
  /** True when the durable identity OR a runtime registry readback reports
   *  the target. */
  permissionTargetConfirmed(target: string, session: Agent['session']): boolean
  /** Poll fold/registry readback for the target within a grace window. */
  confirmPermissionTarget(target: string, session: Agent['session'], timeoutMs: number): Promise<boolean>
  /** Official `/permission <preset>` switch (or the service write fallback),
   *  then confirmation. The TUI never fabricates permission events. */
  applyPermissionIdentity(target: string): Promise<boolean>
  /** Static-mode guard: canonicalize a durable identity BEFORE atoms, and
   *  fail closed when no canonical preset exists for the target bundle. */
  canonicalizeForMode(spec: SessionModeSpec, session: Agent['session']): Promise<boolean>
  /** Capture the preset the user is on before plan mode runs. */
  rememberPrePlanIdentity(session: Agent['session']): void
  /** The captured pre-plan identity, if one is still pending. */
  prePlanPermissionIdentity(session: Agent['session']): string | undefined
  forgetPrePlanIdentity(session: Agent['session']): void
  /** `ChannelUi.runPermissionPreset` (see the public Channel type). */
  runPermissionPreset(name: string): Promise<boolean>
}

/**
 * Durable `permission/preset` identity: readback, canonical mapping, the
 * official switch path, and the pre-plan identity memory. Construction is
 * inert — it acquires nothing and subscribes to nothing.
 */
export function createPermissionIdentity(
  ctx: Context,
  deps: {
    agent: () => Agent
    roster: PermissionModeRoster
    commandService?: { find(agent: Agent, name: string): unknown }
    executeRegistryCommand(name: string, input: string): Promise<string | undefined>
    notify: ChannelState['notify']
  },
): PermissionIdentity {
  /** Durable preset identity captured when plan mode starts; an implicit plan
   *  exit prefers returning to it over the canonical bundle of the restored
   *  atoms, so the user lands back on their own preset (e.g. a third-party
   *  `auto`), not on a look-alike static mode. */
  const prePlanIdentity = new WeakMap<object, string>()

  const fold = (session: Agent['session']): string | undefined => foldPermissionPreset(snapshotLiveSessionEvents(session))

  const canonicalForMode = (
    spec: SessionModeSpec,
    session: Agent['session'],
  ): string | undefined => {
    const sandbox = effectiveSandboxForMode(ctx, spec, snapshotLiveSessionEvents(session))
    const approval = effectiveApprovalForMode(ctx, spec, session)
    if (sandbox === undefined || approval === undefined) return undefined
    return deps.roster.canonicalFor(sandbox, approval)
  }

  const targetConfirmed = (target: string, session: Agent['session']): boolean => {
    if (fold(session) === target) return true
    try {
      const snapshot = deps.roster.readSnapshot(deps.agent())
      if (
        snapshot !== undefined
        && snapshot.current?.kind === 'preset'
        && snapshot.current.value === target
      ) {
        return true
      }
    } catch {
      // The registry may be unmounted mid-switch; the fold check above
      // remains authoritative for the durable identity.
    }
    return false
  }

  const confirmTarget = async (
    target: string,
    session: Agent['session'],
    timeoutMs: number,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (session !== deps.agent().session) return false
      if (targetConfirmed(target, session)) return true
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    ctx.logger.warn(
      `dsh-tui: permission mode "${target}" was not confirmed by permissionPresets.current()/permission/preset`,
    )
    deps.notify(t('mode-permission-unconfirmed'), { color: 'warning' })
    return false
  }

  const apply = async (target: string): Promise<boolean> => {
    if (!isCommandCompletionToken(target)) {
      ctx.logger.warn(`dsh-tui: permission mode "${target}" skipped because its identity is not a safe command token`)
      return false
    }
    const agent = deps.agent()
    const session = agent.session
    if (targetConfirmed(target, session)) return true
    let registered = false
    try {
      registered = deps.commandService?.find(agent, 'permission') !== undefined
    } catch {
      registered = false
    }
    if (!registered) {
      // The same handler the official command drives; the TUI never appends
      // a permission event itself.
      let service: unknown
      try {
        service = ctx.get('permissionPresets')
      } catch {
        service = undefined
      }
      const runtime = permissionPresetRuntime(service)
      if (runtime !== undefined && typeof runtime.set === 'function') {
        try {
          runtime.set(session, target)
        } catch (error) {
          ctx.logger.warn(
            `dsh-tui: permission mode "${target}" could not be applied by the permissionPresets service: ${error instanceof Error ? error.message : String(error)}`,
          )
          deps.notify(t('mode-permission-invoke-failed'), { color: 'warning' })
          return false
        }
        return await confirmTarget(target, session, 2000)
      }
      ctx.logger.warn(`dsh-tui: permission mode "${target}" skipped because /permission is not registered`)
      deps.notify(t('mode-permission-unregistered'), { color: 'warning' })
      return false
    }
    const result = await deps.executeRegistryCommand('permission', ` ${target}`)
    if (session !== deps.agent().session) return false
    if (result === undefined) {
      ctx.logger.warn(`dsh-tui: permission mode "${target}" could not invoke /permission`)
      deps.notify(t('mode-permission-invoke-failed'), { color: 'warning' })
      return false
    }
    let availability: 'runtime' | 'unavailable' = 'unavailable'
    try {
      availability = deps.roster.readSnapshot(deps.agent()) === undefined ? 'unavailable' : 'runtime'
    } catch {
      // keep the default (fail-closed short grace)
    }
    return await confirmTarget(target, session, availability === 'runtime' ? 2000 : 300)
  }

  const canonicalizeForMode = async (
    spec: SessionModeSpec,
    session: Agent['session'],
  ): Promise<boolean> => {
    // Static modes own a canonical permission identity. Leaving any OTHER
    // durable identity behind (third-party preset OR a stale canonical, e.g.
    // plan left `read-only` while atoms were restored to workspace-write)
    // would make a static mode appear selected only because its
    // sandbox/approval bundle happens to match, and would let the durable
    // identity lie about the real policy.
    const current = fold(session)
    if (current === undefined || current === PERMISSION_PRESET_CUSTOM) return true
    const canonical = canonicalForMode(spec, session)
    if (canonical === undefined) {
      ctx.logger.warn(
        `dsh-tui: static mode "${spec.id}" cannot safely clear permission identity "${current}"`,
      )
      deps.notify(t('mode-permission-no-canonical', { name: modeDisplayName(spec) }), { color: 'warning' })
      return false
    }
    if (canonical === current) return true
    return apply(canonical)
  }

  const rememberPrePlanIdentity = (session: Agent['session']): void => {
    // The runtime registry must still recognize the identity as current: a
    // drifted knob combination reads back as custom and must fall back to the
    // canonical bundle of the restored atoms.
    const identity = fold(session)
    if (identity === undefined || identity === PERMISSION_PRESET_CUSTOM) {
      prePlanIdentity.delete(session)
      return
    }
    try {
      const snapshot = deps.roster.readSnapshot(deps.agent())
      if (snapshot === undefined) {
        prePlanIdentity.delete(session)
        return
      }
      if (snapshot.current?.kind !== 'preset' || snapshot.current.value !== identity) {
        prePlanIdentity.delete(session)
        return
      }
      if (!snapshot.options.some(option => option.value === identity)) {
        prePlanIdentity.delete(session)
        return
      }
      prePlanIdentity.set(session, identity)
    } catch {
      prePlanIdentity.delete(session)
    }
  }

  return {
    foldPermissionPreset: fold,
    canonicalPermissionForMode: canonicalForMode,
    permissionTargetConfirmed: (target, session) => targetConfirmed(target, session),
    confirmPermissionTarget: (target, session, timeoutMs) => confirmTarget(target, session, timeoutMs),
    applyPermissionIdentity: apply,
    canonicalizeForMode,
    rememberPrePlanIdentity,
    prePlanPermissionIdentity: session => prePlanIdentity.get(session),
    forgetPrePlanIdentity: session => { prePlanIdentity.delete(session) },
    runPermissionPreset: name => apply(name.trim()),
  }
}
