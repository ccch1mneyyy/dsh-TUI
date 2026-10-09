import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { assertShadowPolicy } from '../../adapter/kernel/runtime.js'
import { t } from '../../i18n.js'
import { readPermissionPref, writePermissionPref } from '../../permissionPrefs.js'
import { modeDisplayName, type SessionModeSpec } from '../../sessionModes.js'
import { snapshotLiveSessionEvents } from '../compat/liveSession.js'
import type { DshChannelBinding } from './binding.js'
import { createModeActions, reportModeSwitchFailure } from './mode-actions.js'
import { createPermissionIdentity, foldPermissionPreset, type PermissionIdentity } from './mode-permission.js'
import { PERMISSION_PRESET_CUSTOM } from './permissions.js'
import type { PermissionModeRoster } from './mode-roster.js'
import type { ChannelState } from './types.js'

type Binding = DshChannelBinding
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
    'owner' | 'runtime' | 'binding' | 'sessionModes' | 'executeRegistryCommand' | 'notify'
  > & {
    roster: PermissionModeRoster
    /** Only the permission identity reads the registry directly (#755 is the
     *  authoritative design for `/permission`); the plan route comes from the
     *  shared capability facts inside `createModeActions`. */
    commandService?: { find(agent: Agent, name: string): unknown }
  },
): {
  refreshMode(): void
  cycleMode(): Promise<void>
  applyMode(spec: SessionModeSpec, capture?: ModeCapture): Promise<void>
  onSessionEvent(session: unknown, event: unknown): void
  applyRememberedPermission(): Promise<void>
  runPermissionPreset(name: string): Promise<boolean>
  permission: PermissionIdentity
} {
  const { owner, binding, sessionModes, roster, commandService, executeRegistryCommand, notify } = deps
  const base = createModeActions(ctx, state, {
    owner,
    runtime: deps.runtime,
    binding,
    sessionModes,
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

  /** True while this composition is walking a session INTO plan mode — from
   *  the pre-plan identity capture until the plan atoms have been applied.
   *  The canonical preset the plan entry switches to is a transient working
   *  state (restored on exit), so the preference must not learn it. */
  let planEntryInFlight = false
  /** Sessions the remembered permission was already seeded into (or decided
   *  against): one attempt per session object, rebinds stay quiet. */
  const permissionPrefSeeded = new WeakSet<object>()

  /** Remember one durable permission identity for the next session (see
   *  permissionPrefs.ts). Undefined and custom identities carry no preset
   *  to remember; a failed write is a debug line, never user-facing. */
  const persistPermissionPref = (value: string | undefined): void => {
    if (value === undefined || value === PERMISSION_PRESET_CUSTOM) return
    if (!writePermissionPref(value)) {
      ctx.logger.debug(`dsh-tui: permission preference write failed for "${value}"`)
    }
  }

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
   *  permission events. Never rejects: a half-applied switch (identity landed,
   *  atoms refused) is reported and the indicator is re-derived — the caller
   *  is the Shift+Tab keyboard entry, which cannot await. */
  const applyMode = async (spec: SessionModeSpec, capture?: ModeCapture): Promise<void> => {
    try {
      await applyModeUnsafe(spec, capture ?? binding.capture())
    } catch (error) {
      reportModeSwitchFailure(ctx, notify, refreshMode, error)
    }
  }

  const applyModeUnsafe = async (spec: SessionModeSpec, capture: ModeCapture): Promise<void> => {
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
      // The canonicalization below reseats the durable identity on the
      // plan atoms (read-only/ask) until the exit restores it. Keep the
      // preference on the identity the user actually sat on, and let the
      // event observer below ignore the replacement while it is in flight.
      persistPermissionPref(foldPermissionPreset(snapshotLiveSessionEvents(session)))
      planEntryInFlight = true
    }
    if (planChange && spec.plan === false) {
      // An explicit switch away from plan owns its target mode; the
      // remembered pre-plan identity no longer applies.
      explicitPlanExits.add(session)
      permission.forgetPrePlanIdentity(session)
    }
    try {
      if (spec.permission !== undefined) {
        if (!(await permission.applyPermissionIdentity(spec.permission))) return
        persistPermissionPref(spec.permission)
      } else if (!(await permission.canonicalizeForMode(spec, session))) {
        return
      } else if (spec.plan !== true) {
        // A static mode the user cycled to owns its canonical preset
        // identity (the plan spec's canonical form is transient instead).
        persistPermissionPref(permission.canonicalPermissionForMode(spec, session))
      }
      if (!owner.current() || !binding.isCurrent(capture) || session !== agent.session) return
      await base.applyMode(spec, capture)
    } finally {
      planEntryInFlight = false
    }
    if (!owner.current() || !binding.isCurrent(capture)) return
    const before = state.modeIndex
    refreshMode()
    if (state.modeIndex !== before) state.emit()
  }

  /** Shift+Tab: advance from the mode DERIVED from the session log (never a
   *  stored index), so manual `/plan` use can never desync the cycle. Never
   *  rejects — same fail-soft contract as {@link applyMode}. */
  const cycleMode = async (): Promise<void> => {
    try {
      const capture = binding.capture()
      if (!owner.current() || !binding.isCurrent(capture)) return
      const index = derivePermissionModeIndex(sessionModes, snapshotLiveSessionEvents(capture.agent.session))
      await applyMode(sessionModes[(index + 1) % sessionModes.length]!, capture)
    } catch (error) {
      reportModeSwitchFailure(ctx, notify, refreshMode, error)
    }
  }

  const onSessionEvent = (session: unknown, event: unknown): void => {
    const subject = session as Agent['session']
    const sessionEvent = event as SessionEvent
    base.onSessionEvent(subject, sessionEvent)
    const type = (sessionEvent as { type: string }).type
    if (type === 'permission/preset') {
      refreshMode()
      // Every durable identity change on the bound session teaches the
      // preference — including switches the official /permission command
      // performed on its own (typed input, other UIs over the same
      // registry) — except the two plan-transition shapes: the canonical
      // preset a plan entry reseats to (in flight below) and any identity
      // switched to while plan is active (the exit restore re-seats the
      // pre-plan one, and that restore event lands here again).
      if (!planEntryInFlight && !foldPlanActive(snapshotLiveSessionEvents(subject))) {
        persistPermissionPref(foldPermissionPreset(snapshotLiveSessionEvents(subject)))
      }
    }
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

  /** Seed a session that never customized its permission planes with the
   *  persisted preference (permissionPrefs.ts): the last preset the user
   *  switched to, applied through the same official /permission path every
   *  manual switch takes. Idempotent by construction — once any
   *  permission/sandbox/approval event exists in the log, the session owns
   *  its planes and is left alone. Never rejects.
   *
   *  Yields to a DSH_PERMISSION_MODE deployment pin (the composition's
   *  sandbox-policy/approval defaults came from it) and to shadow
   *  runtimes, which must not write durable session policy. */
  const applyRememberedPermission = async (): Promise<void> => {
    try {
      if (deps.runtime.mode === 'passive-shadow' || deps.runtime.mode === 'replay-shadow') return
      const pinned = process.env.DSH_PERMISSION_MODE
      if (pinned !== undefined && pinned !== '') return
      const pref = readPermissionPref()
      if (pref === undefined) return
      const agent = binding.agent
      const session = agent.session
      if (permissionPrefSeeded.has(session)) return
      // A session that already holds any permission-plane event chose its
      // own state (or was resumed with one); only untouched planes seed.
      for (const event of snapshotLiveSessionEvents(session)) {
        const known = (event as { type: string }).type
        if (known === 'permission/preset' || known === 'sandbox/mode' || known === 'approval/policy') return
      }
      // Fail closed against the mounted roster: an identity this
      // deployment does not offer must not be driven through /permission
      // (it would surface as a boot-time switch failure).
      const snapshot = roster.readSnapshot(agent)
      if (snapshot === undefined || !snapshot.options.some(option => option.value === pref)) {
        permissionPrefSeeded.add(session)
        ctx.logger.debug(`dsh-tui: remembered permission preset "${pref}" is not on the mounted roster; skipped`)
        return
      }
      permissionPrefSeeded.add(session)
      const ok = await permission.applyPermissionIdentity(pref)
      if (ok && owner.current() && session === binding.agent.session) {
        refreshMode()
        state.emit()
      }
    } catch (error) {
      ctx.logger.warn(`dsh-tui: remembered permission could not be applied: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    refreshMode,
    cycleMode,
    applyMode,
    onSessionEvent,
    applyRememberedPermission,
    runPermissionPreset: name => permission.runPermissionPreset(name),
    permission,
  }
}
