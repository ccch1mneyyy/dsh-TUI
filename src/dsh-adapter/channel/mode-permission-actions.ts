import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { assertShadowPolicy } from '../../adapter/kernel/runtime.js'
import { t } from '../../i18n.js'
import { readPermissionPref, writePermissionPref } from '../../permissionPrefs.js'
import { PERMISSION_PRESET_AUTO } from '../../permissionPresetLabels.js'
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

/** The durable identity held before the latest `permission/preset` event.
 *  Non-string presets are skipped exactly as {@link foldPermissionPreset}
 *  skips them, so both folds agree on what the session sat on. */
function previousPermissionPreset(events: readonly SessionEvent[]): string | undefined {
  let previous: string | undefined
  let latest: string | undefined
  for (const event of events) {
    if ((event as { type: string }).type !== 'permission/preset') continue
    const preset = (event.data as unknown as { preset?: unknown }).preset
    if (typeof preset !== 'string') continue
    previous = latest
    latest = preset
  }
  return previous
}

/** Whether this session's log ever selected the experimental `auto` preset
 *  (picker confirmation, typed command, or a resumed Auto session). Only then
 *  may Shift+Tab land on it: a key press cannot await the risk confirmation. */
export function autoPresetConfirmed(events: readonly SessionEvent[]): boolean {
  return events.some(event =>
    (event as { type: string }).type === 'permission/preset'
    && (event.data as unknown as { preset?: unknown }).preset === PERMISSION_PRESET_AUTO)
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
    'owner' | 'runtime' | 'binding' | 'sessionModes' | 'executeRegistryCommand' | 'notify' | 'pushLocal'
  > & {
    roster: PermissionModeRoster
    /** Only the permission identity reads the registry directly (#755 is the
     *  authoritative design for `/permission`); the plan route comes from the
     *  shared capability facts inside `createModeActions`. */
    commandService?: { find(agent: Agent, name: string): unknown }
    executeRegistryCommandOutcome?: ChannelState['runExternalCommandOutcome']
  },
): {
  refreshMode(): void
  cycleMode(): Promise<void>
  applyMode(spec: SessionModeSpec, capture?: ModeCapture): Promise<void>
  onSessionEvent(session: unknown, event: unknown): void
  applyRememberedPermission(): Promise<void>
  runPermissionPreset(name: string): Promise<boolean>
  trackUserPermissionSwitch<T>(target: string, run: () => Promise<T>): Promise<T>
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
    pushLocal: deps.pushLocal,
  })
  const permission = createPermissionIdentity(ctx, {
    agent: () => binding.agent,
    roster,
    commandService,
    executeRegistryCommand,
    notify,
    pushLocal: deps.pushLocal,
    executeRegistryCommandOutcome: deps.executeRegistryCommandOutcome,
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
  /** Target presets of the permission switches this TUI is driving right now
   *  (the `/permission` command or the service write path). A switch AWAY
   *  from `auto` is learned only when it lands on one of them: the
   *  auto-review plugin migrates every Auto session to danger-full-access
   *  when it unloads, and that migration — even one racing a pending switch
   *  to another target — must not become the next session's default. */
  const userPermissionTargets: string[] = []
  /** Per session, the identity a switch away from `auto` landed on without
   *  being learned (the plugin-unload migration). It stays unlearnable on
   *  the implicit paths — a plan entry's pre-plan seat and the plan exit's
   *  restore — until an explicit switch is learned on that session. */
  const unlearnedIdentity = new WeakMap<object, string>()
  /** `input` is the raw `/permission` argument; its first token names the
   *  target preset, resolved case-insensitively against the mounted roster
   *  so it compares equal to the value the log records. */
  const trackUserPermissionSwitch = async <T>(input: string, run: () => Promise<T>): Promise<T> => {
    const typed = input.trim().split(/\s+/)[0] ?? ''
    let options: readonly { value: string }[] = []
    try {
      options = roster.readSnapshot(binding.agent)?.options ?? []
    } catch {
      options = []
    }
    const target = options.find(option => option.value.toLowerCase() === typed.toLowerCase())?.value ?? typed
    userPermissionTargets.push(target)
    try {
      return await run()
    } finally {
      userPermissionTargets.splice(userPermissionTargets.indexOf(target), 1)
    }
  }

  /** Remember one durable permission identity for the next session (see
   *  permissionPrefs.ts). Undefined and custom identities carry no preset
   *  to remember, and `auto` is session-only by contract; a failed write is a
   *  debug line, never user-facing. */
  const persistPermissionPref = (value: string | undefined): void => {
    if (value === undefined || value === PERMISSION_PRESET_CUSTOM || value === PERMISSION_PRESET_AUTO) return
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
      reportModeSwitchFailure(ctx, notify, refreshMode, error, deps.pushLocal)
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
      const seat = foldPermissionPreset(snapshotLiveSessionEvents(session))
      if (seat !== unlearnedIdentity.get(session)) persistPermissionPref(seat)
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
        unlearnedIdentity.delete(session)
        persistPermissionPref(spec.permission)
      } else if (!(await permission.canonicalizeForMode(spec, session))) {
        return
      } else if (spec.plan !== true) {
        // A static mode the user cycled to owns its canonical preset
        // identity (the plan spec's canonical form is transient instead).
        unlearnedIdentity.delete(session)
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
   *  stored index), so manual `/plan` use can never desync the cycle; `auto`
   *  is skipped unless {@link autoPresetConfirmed}. Never rejects — same
   *  fail-soft contract as {@link applyMode}. */
  const cycleMode = async (): Promise<void> => {
    try {
      const capture = binding.capture()
      if (!owner.current() || !binding.isCurrent(capture)) return
      const events = snapshotLiveSessionEvents(capture.agent.session)
      const index = derivePermissionModeIndex(sessionModes, events)
      const autoConfirmed = autoPresetConfirmed(events)
      // One full revolution, ending on the starting entry: a single-mode
      // cycle re-applies it (the session's atoms may have drifted from it).
      for (let step = 1; step <= sessionModes.length; step++) {
        const next = sessionModes[(index + step) % sessionModes.length]!
        if (next.permission === PERMISSION_PRESET_AUTO && !autoConfirmed) continue
        await applyMode(next, capture)
        return
      }
    } catch (error) {
      reportModeSwitchFailure(ctx, notify, refreshMode, error, deps.pushLocal)
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
      // pre-plan one, and that restore event lands here again). Leaving
      // `auto` is learned only when it lands on a target this TUI is driving
      // (see trackUserPermissionSwitch), and an unlearned landing stays
      // unlearned when a plan exit re-seats it; explicit mode switches
      // persist on their own.
      const events = snapshotLiveSessionEvents(subject)
      const current = foldPermissionPreset(events)
      const userDriven = current !== undefined && userPermissionTargets.includes(current)
      if (planEntryInFlight || foldPlanActive(events)) {
        // Plan transition shapes: never learned.
      } else if (previousPermissionPreset(events) === PERMISSION_PRESET_AUTO && !userDriven) {
        if (current !== undefined) unlearnedIdentity.set(subject, current)
      } else if (userDriven || current !== unlearnedIdentity.get(subject)) {
        unlearnedIdentity.delete(subject)
        persistPermissionPref(current)
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

  /** The composition's default preset: the identity `dsh-permission-presets`
   *  pins into EVERY fresh session before it is published (`session/created` →
   *  `pinInitialPermission`), read fail-closed from the mounted service —
   *  undefined when it is absent or answers nothing usable. */
  const compositionDefaultPreset = (): string | undefined => {
    try {
      const service = ctx.get('permissionPresets') as { defaultPreset?: unknown } | undefined
      const value = service?.defaultPreset
      return typeof value === 'string' && value !== '' ? value : undefined
    } catch {
      return undefined
    }
  }

  /** Seed a session that never customized its permission planes with the
   *  persisted preference (permissionPrefs.ts): the last preset the user
   *  switched to, applied through the same official /permission path every
   *  manual switch takes. Never rejects.
   *
   *  Holding permission-plane events is NOT evidence of a user choice: the
   *  composition pins `permission/preset` + `sandbox/mode` + `approval/policy`
   *  into every fresh session at creation. So a session only owns its planes
   *  when the log shows more than that pin — it ran a turn, or its durable
   *  identity is one the composition did not pin (`custom`, a preset a user
   *  switched to, a resumed log's own state). Everything else is untouched
   *  and seeds, which is what "starts where the last session ended" means.
   *
   *  Yields to a DSH_PERMISSION_MODE launch pin (the composition's
   *  sandbox-policy/approval defaults came from it, so that invocation
   *  explicitly asked for that start state) and to shadow runtimes, which
   *  must not write durable session policy. */
  const applyRememberedPermission = async (): Promise<void> => {
    try {
      if (deps.runtime.mode === 'passive-shadow' || deps.runtime.mode === 'replay-shadow') return
      const pinned = process.env.DSH_PERMISSION_MODE
      if (pinned !== undefined && pinned !== '') return
      const pref = readPermissionPref()
      // `auto` is session-only; a preference written before that rule never
      // seeds a fresh session into it.
      if (pref === undefined || pref === PERMISSION_PRESET_AUTO) return
      const agent = binding.agent
      const session = agent.session
      if (permissionPrefSeeded.has(session)) return
      const events = snapshotLiveSessionEvents(session)
      const pinnedIdentity = compositionDefaultPreset()
      let touchesPlanes = false
      for (const event of events) {
        const known = (event as { type: string }).type
        if (known === 'permission/preset' || known === 'sandbox/mode' || known === 'approval/policy') {
          touchesPlanes = true
        } else if (known === 'turn/start') {
          // The session has been used: its planes are the ones it ran with,
          // never this boot's preference.
          return
        }
      }
      if (touchesPlanes && (pinnedIdentity === undefined || foldPermissionPreset(events) !== pinnedIdentity)) return
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
    runPermissionPreset: name => trackUserPermissionSwitch(name, () => permission.runPermissionPreset(name)),
    trackUserPermissionSwitch,
    permission,
  }
}
