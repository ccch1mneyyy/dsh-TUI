import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { assertShadowPolicy } from '../../adapter/kernel/runtime.js'
import { t } from '../../i18n.js'
import { modeDisplayName, type SessionModeSpec } from '../../sessionModes.js'
import { snapshotLiveSessionEvents } from '../compat/liveSession.js'
import type { createChannelBinding } from './binding.js'
import { createModeActions } from './mode-actions.js'
import { createPermissionIdentity, foldPermissionPreset, type PermissionIdentity } from './mode-permission.js'
import type { PermissionModeRoster } from './mode-roster.js'
import type { ChannelState } from './types.js'

type Binding = ReturnType<typeof createChannelBinding>
type ModeState = Pick<ChannelState, 'mode' | 'modeIndex' | 'emit'>
type ModeCapture = ReturnType<Binding['capture']>
/** The composition seam `createModeActions` owns; this factory forwards every
 *  member verbatim so both stay in lockstep. */
type BaseModeActionDeps = Parameters<typeof createModeActions>[2]

// Atom folds mirrored from mode-actions.ts: `createModeActions` does not
// export them, and the permission-aware derive below must reproduce its
// atom fallback exactly to stay the single source of the indicator.
const foldPlanActive = (events: readonly SessionEvent[]): boolean => {
  let active = false
  for (const event of events) {
    if ((event as { type: string }).type === 'plan/mode') {
      active = (event.data as unknown as { active?: boolean }).active === true
    }
  }
  return active
}
const foldSandboxMode = (events: readonly SessionEvent[]): string | undefined => {
  let mode: string | undefined
  for (const event of events) {
    if ((event as { type: string }).type === 'sandbox/mode') {
      const value = (event.data as unknown as { mode?: string }).mode
      if (typeof value === 'string') mode = value
    }
  }
  return mode
}
const foldApprovalPolicy = (events: readonly SessionEvent[]): string | undefined => {
  let policy: string | undefined
  for (const event of events) {
    if ((event as { type: string }).type === 'approval/policy') {
      const value = (event.data as unknown as { policy?: string }).policy
      if (typeof value === 'string') policy = value
    }
  }
  return policy
}

/**
 * Durable-identity-first mode index. A durable permission identity is
 * STRONGER than the derived sandbox/approval atoms: it keeps a runtime preset
 * (including one that maps to the same atoms as a static mode) selected after
 * resume or manual commands instead of snapping to a look-alike static mode.
 * Permission-only dynamic specs declare no atoms and would wildcard-match ANY
 * session state, so they can only be selected through the identity branch —
 * never through the atom fallback.
 */
function derivePermissionModeIndex(
  modes: readonly SessionModeSpec[],
  events: readonly SessionEvent[],
): number {
  const identity = foldPermissionPreset(events)
  if (identity !== undefined) {
    const permissionIndex = modes.findIndex(
      spec =>
        spec.permission === identity
        && (spec.plan === undefined || foldPlanActive(events) === spec.plan),
    )
    if (permissionIndex >= 0) return permissionIndex
  }
  const index = modes.findIndex(
    spec =>
      spec.permission === undefined
      && (spec.plan === undefined || foldPlanActive(events) === spec.plan)
      && (spec.sandbox === undefined || foldSandboxMode(events) === spec.sandbox)
      && (spec.approval === undefined || foldApprovalPolicy(events) === spec.approval),
  )
  return index >= 0 ? index : 0
}

/**
 * Permission-aware session-mode actions: main's mode transition (plan
 * exclusivity, atom application, plan-exit restore) composed with the durable
 * permission identity, on top of the refactored `createModeActions`.
 *
 * Construction is inert. The returned shape is a superset of
 * `ReturnType<typeof createModeActions>`, so the composition root and
 * `createBindingEvents` can consume it unchanged, plus
 * `runPermissionPreset` for the public `ChannelUi` surface.
 */
export function createPermissionModeActions(
  ctx: Context,
  state: ModeState,
  deps: Pick<
    BaseModeActionDeps,
    'owner' | 'runtime' | 'binding' | 'sessionModes' | 'commandService' | 'executeRegistryCommand' | 'notify'
  > & { roster: PermissionModeRoster },
): {
  refreshMode(): void
  cycleMode(): Promise<void>
  applyMode(spec: SessionModeSpec, capture?: ModeCapture): Promise<void>
  onSessionEvent(session: unknown, event: unknown): void
  runPermissionPreset(name: string): Promise<boolean>
  permission: PermissionIdentity
} {
  const { owner, binding, sessionModes, roster, commandService, executeRegistryCommand, notify } = deps
  const base = createModeActions(ctx, state, {
    owner,
    runtime: deps.runtime,
    binding,
    sessionModes,
    commandService,
    executeRegistryCommand,
    notify,
  })
  const permission = createPermissionIdentity(ctx, {
    agent: () => binding.agent,
    roster,
    commandService,
    executeRegistryCommand,
    notify,
  })
  // An in-turn /plan off commits at pre-step, after the command has returned.
  const explicitPlanExits = new WeakSet<object>()

  /** Re-derive the roster and the current mode. The roster rebuild rides on
   *  every refresh: a registry mount/unmount and a re-bind both land here. */
  const refreshMode = (): void => {
    roster.rebuild(binding.agent)
    const index = derivePermissionModeIndex(sessionModes, snapshotLiveSessionEvents(binding.agent.session))
    state.modeIndex = index
    state.mode = sessionModes[index]!
  }

  /** Apply the configured atoms; an explicit exit owns its target mode.
   *  Permission identity is applied BEFORE plan and atom changes: dynamic
   *  presets use the official command path (or the service write fallback)
   *  and are confirmed by event/registry readback; the TUI never manufactures
   *  permission events. */
  const applyMode = async (spec: SessionModeSpec, capture: ModeCapture = binding.capture()): Promise<void> => {
    if (!owner.current() || !binding.isCurrent(capture)) return
    // This action writes durable session policy; the permission switch writes
    // the same kind of durable identity, so it is under the same guard.
    assertShadowPolicy('mutate', deps.runtime.mode)
    const agent = capture.agent
    const session = agent.session
    const planMode = ctx.get('planMode') as
      | { get?(a: Agent): { active: boolean; pending?: boolean } }
      | undefined
    const planActive = foldPlanActive(snapshotLiveSessionEvents(session))
    const planChange = spec.plan !== undefined && (planMode?.get?.(agent).pending ?? planActive) !== spec.plan
    if (planActive && planMode?.get?.(agent).pending === undefined) {
      explicitPlanExits.delete(session)
    }
    // Capture the pre-plan preset identity BEFORE any permission
    // canonicalization can append replacement events.
    if (planChange && spec.plan === true && !planActive) {
      permission.rememberPrePlanIdentity(session)
    }
    if (planChange && spec.plan === false) {
      // An explicit switch away from plan owns its target mode; the
      // remembered pre-plan identity no longer applies.
      explicitPlanExits.add(session)
      permission.forgetPrePlanIdentity(session)
    }
    if (spec.permission !== undefined) {
      if (!(await permission.applyPermissionIdentity(spec.permission))) return
    } else if (!(await permission.canonicalizeForMode(spec, session))) {
      return
    }
    if (!owner.current() || !binding.isCurrent(capture) || session !== agent.session) return
    await base.applyMode(spec, capture)
    if (!owner.current() || !binding.isCurrent(capture)) return
    const before = state.modeIndex
    refreshMode()
    if (state.modeIndex !== before) state.emit()
  }

  /** Shift+Tab: advance from the mode DERIVED from the session log (never a
   *  stored index), so manual `/plan` use can never desync the cycle. */
  const cycleMode = async (): Promise<void> => {
    const capture = binding.capture()
    if (!owner.current() || !binding.isCurrent(capture)) return
    const index = derivePermissionModeIndex(sessionModes, snapshotLiveSessionEvents(capture.agent.session))
    await applyMode(sessionModes[(index + 1) % sessionModes.length]!, capture)
  }

  const onSessionEvent = (session: unknown, event: unknown): void => {
    const subject = session as Agent['session']
    const sessionEvent = event as SessionEvent
    base.onSessionEvent(subject, sessionEvent)
    const type = (sessionEvent as { type: string }).type
    if (type === 'permission/preset') refreshMode()
    if (type !== 'plan/mode' || (sessionEvent.data as unknown as { active?: boolean }).active !== false) return
    const remembered = permission.prePlanPermissionIdentity(subject)
    const explicit = explicitPlanExits.delete(subject)
    permission.forgetPrePlanIdentity(subject)
    if (explicit || remembered === undefined) return
    if (subject !== binding.agent.session) return
    // The atom restore is queued by the base actions in this same turn; the
    // identity restore runs after it and re-seats the user on their own
    // preset. Both write the same atom values, so the order cannot diverge.
    queueMicrotask(() => {
      if (subject !== binding.agent.session || foldPlanActive(snapshotLiveSessionEvents(subject))) return
      void permission.applyPermissionIdentity(remembered).then((ok) => {
        if (!ok || subject !== binding.agent.session) return
        refreshMode()
        notify(t('mode-switched', { name: modeDisplayName(state.mode) }))
        state.emit()
      }).catch(() => {
        // Best-effort; failures already surfaced through applyPermissionIdentity.
      })
    })
  }

  return {
    refreshMode,
    cycleMode,
    applyMode,
    onSessionEvent,
    runPermissionPreset: name => permission.runPermissionPreset(name),
    permission,
  }
}
