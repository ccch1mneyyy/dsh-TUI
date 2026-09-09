import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { t } from '../../i18n.js'
import { modeDisplayName, type SessionModeSpec } from '../../sessionModes.js'
import { assertShadowPolicy, type AdapterRuntimeOptions } from '../../adapter/kernel/runtime.js'
import type { ChannelState } from './types.js'
import { snapshotLiveSessionEvents } from '../compat/liveSession.js'
import type { createChannelBinding } from './binding.js'

type Binding = ReturnType<typeof createChannelBinding>
type ModeState = Pick<ChannelState, 'mode' | 'modeIndex' | 'emit'>

/** Durable session-mode folds and transitions. Construction is inert; root wires it after state construction. */
export function createModeActions(
  ctx: Context,
  state: ModeState,
  deps: {
    owner: { current(): boolean }
    runtime: AdapterRuntimeOptions
    binding: Pick<Binding, 'agent' | 'capture' | 'isCurrent'>
    sessionModes: readonly SessionModeSpec[]
    commandService?: { find(agent: Agent, name: string): unknown }
    executeRegistryCommand(name: string, input: string): Promise<string | undefined>
    notify: ChannelState['notify']
  },
) {
  const { owner, runtime, binding, sessionModes, commandService, executeRegistryCommand, notify } = deps
  type ModeCapture = ReturnType<Binding['capture']>
  const current = (capture: ModeCapture): boolean => owner.current() && binding.isCurrent(capture)
  const capturedSession = (capture: ModeCapture) => capture.agent.session
// Session-mode folds: last-wins projections over the session log. The
// event types are registered by dsh-plan-mode / dsh-sandbox-policy /
// dsh-user-approval and are NOT in this package's typed SessionEvent
// union, so they are matched by name through casts — the same pattern as
// `agent-preset/selected` in renderEvent and the goal projection above.
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

/** First configured mode whose declared atoms all match the folds;
 *  undeclared atoms are wildcards; no match → index 0 (the base mode).
 *  Matching is exact: a fresh session has no `approval/policy` event, so
 *  a mode declaring `approval: 'ask'` never falsely matches it. */
const deriveModeIndex = (events: readonly SessionEvent[]): number => {
  const index = sessionModes.findIndex(
    spec =>
      (spec.plan === undefined || foldPlanActive(events) === spec.plan) &&
      (spec.sandbox === undefined || foldSandboxMode(events) === spec.sandbox) &&
      (spec.approval === undefined || foldApprovalPolicy(events) === spec.approval),
  )
  return index >= 0 ? index : 0
}

/** Re-derive the current mode from the live session log (boot, every
 *  agent re-bind, and after mode-affecting session events). */
const refreshMode = (): void => {
  state.modeIndex = deriveModeIndex(snapshotLiveSessionEvents(binding.agent.session))
  state.mode = sessionModes[state.modeIndex]!
}

  // Session.append rejects observer reentry; restore after publication
  // unwinds. These are channel-scoped so a disposed/recreated Channel cannot
  // inherit deferred work from a former owner.
  const pendingPlanExitRestores = new Map<object, { capture: ModeCapture; target: SessionModeSpec }>()
  const prePlanModes = new WeakMap<object, SessionModeSpec>()
  // An in-turn /plan off commits at pre-step, after the command has returned.
  const explicitPlanExits = new WeakSet<object>()

const modePermissions = (events: readonly SessionEvent[]): SessionModeSpec => {
  const sandbox = foldSandboxMode(events)
  const approval = foldApprovalPolicy(events)
  return {
    id: 'restore',
    ...(sandbox === 'read-only' || sandbox === 'workspace-write' || sandbox === 'danger-full-access'
      ? { sandbox } : {}),
    ...(approval === 'ask' || approval === 'never' ? { approval } : {}),
  }
}

/** Recover a resumed plan's snapshot before /plan ran, not before its
 *  deferred plan/mode event. Unknown historical atoms stay untouched. */
const prePlanModeSpec = (log: readonly SessionEvent[]): SessionModeSpec | undefined => {
  let active = false
  let start = -1
  let command: { index: number; id: unknown } | undefined
  for (let index = 0; index < log.length - 1; index += 1) {
    const event = log[index]!
    const type = (event as { type: string }).type
    const data = event.data as unknown as Record<string, unknown>
    if (!active && type === 'command/run' && data.name === 'plan' && typeof data.args === 'string') {
      if (data.args.trim() === 'off') command = undefined
      else command ??= { index, id: data.commandId }
    }
    if (type === 'command/done' && data.commandId === command?.id && data.kind !== 'success') {
      command = undefined
    }
    if (type === 'plan/mode') {
      if (data.active === true && !active) start = command?.index ?? index
      active = data.active === true
      command = undefined
    }
  }
  return active && start >= 0 ? modePermissions(log.slice(0, start)) : undefined
}

  const applyModeAtoms = (spec: SessionModeSpec, capture: ModeCapture): void => {
    if (!current(capture)) return
    const agent = capture.agent
    const session = capturedSession(capture)
    // The durable sandbox override is one session event (dsh-sandbox-policy's
    // own write path); the session/event arm picks it up immediately.
    if (spec.sandbox !== undefined && foldSandboxMode(snapshotLiveSessionEvents(session)) !== spec.sandbox) {
      ;(session as unknown as { append(type: string, data: Record<string, unknown>): unknown }).append(
        'sandbox/mode', { mode: spec.sandbox },
      )
    }
    if (!current(capture)) return
    // Prefer the approval service (it narrates the switch to the model);
    // the raw durable event is the fallback when it is unmounted.
    if (spec.approval !== undefined && foldApprovalPolicy(snapshotLiveSessionEvents(session)) !== spec.approval) {
      const approval = ctx.get('approval') as
        | { setPolicy(a: Agent, policy: 'ask' | 'never'): void }
        | undefined
      approval?.setPolicy(agent, spec.approval)
      if (!current(capture)) return
      // The service may no-op when its configured default already matches.
      if (foldApprovalPolicy(snapshotLiveSessionEvents(session)) !== spec.approval) {
        ;(session as unknown as { append(type: string, data: Record<string, unknown>): unknown }).append(
          'approval/policy', { policy: spec.approval },
        )
      }
    }
  }

/** Apply the configured atoms; an explicit exit owns its target mode. */
  const applyMode = async (spec: SessionModeSpec, capture = binding.capture()): Promise<void> => {
    if (!current(capture)) return
    // This action writes durable session policy. The runtime snapshot comes
    // from composition and is immutable for this Channel lifetime, so an
    // observed plan exit cannot bypass the renderer/Port shadow guard.
    assertShadowPolicy('mutate', runtime.mode)
    const agent = capture.agent
    const session = capturedSession(capture)
    pendingPlanExitRestores.delete(session)
  const planMode = ctx.get('planMode') as
    | { get?(a: Agent): { active: boolean; pending?: boolean } }
    | undefined
  const planActive = foldPlanActive(snapshotLiveSessionEvents(session))
  // Reconcile a stale explicit-exit marker before acting. The marker only
  // legitimately survives while a deferred exit awaits its plan/mode:false
  // (foldPlanActive && pending === false). If plan is still logged active
  // with no pending intent, that awaited event was abandoned (e.g. an
  // aborted pre-step) — drop the orphan so it cannot suppress a later restore
  // such as an approved exit_plan_mode.
  if (planActive && planMode?.get?.(agent).pending === undefined) {
    explicitPlanExits.delete(session)
  }
  if (spec.plan !== undefined && (planMode?.get?.(agent).pending ?? planActive) !== spec.plan) {
    if (commandService?.find(agent, 'plan') === undefined) {
      notify(t('mode-plan-unavailable'), { color: 'warning' })
      return
    }
    if (spec.plan && !planActive && !prePlanModes.has(session)) {
      const previous = modePermissions(snapshotLiveSessionEvents(session))
      const sandbox = ctx.get('sandboxPolicy') as { defaultMode?: SessionModeSpec['sandbox'] } | undefined
      const approval = ctx.get('approval') as { effectivePolicy?(session: Agent['session']): SessionModeSpec['approval'] } | undefined
      const base = previous.sandbox === undefined && previous.approval === undefined ? sessionModes[0] : undefined
      previous.sandbox ??= sandbox?.defaultMode ?? base?.sandbox
      previous.approval ??= approval?.effectivePolicy?.(session) ?? base?.approval
      prePlanModes.set(session, previous)
      // Persist missing defaults before /plan, so resume can recover them.
      applyModeAtoms(previous, capture)
    }
    if (!spec.plan) explicitPlanExits.add(session)
    try {
      const text = await executeRegistryCommand('plan', spec.plan ? '' : ' off')
      if (!current(capture) || session !== capturedSession(capture)) return
      if (text === undefined) {
        notify(t('mode-plan-unavailable'), { color: 'warning' })
        return
      }
    } finally {
      if (current(capture) && session === capturedSession(capture)) {
        const pending = planMode?.get?.(agent).pending
        if (!foldPlanActive(snapshotLiveSessionEvents(session)) || pending !== false) explicitPlanExits.delete(session)
        if (!foldPlanActive(snapshotLiveSessionEvents(session)) && pending !== true) prePlanModes.delete(session)
      }
    }
  }
  if (!current(capture)) return
  applyModeAtoms(spec, capture)
  if (!current(capture)) return
  refreshMode()
  if (!current(capture)) return
  notify(t('mode-switched', { name: modeDisplayName(state.mode) }))
  state.emit()
}

/** Shift+Tab: advance to the next configured session mode. Cycling starts
 *  from the mode DERIVED from the session log (never a stored index), so
 *  manual `/plan` use can never desync the cycle. */
  const cycleMode = async (): Promise<void> => {
    const capture = binding.capture()
    if (!current(capture)) return
    const index = deriveModeIndex(snapshotLiveSessionEvents(capturedSession(capture)))
    await applyMode(sessionModes[(index + 1) % sessionModes.length]!, capture)
  }

  const onSessionEvent = (session: Agent['session'], event: SessionEvent): void => {
    const capture = binding.capture()
    if (!current(capture) || session !== capturedSession(capture)) return
    const eventType = (event as { type: string }).type
    if (eventType === 'plan/mode' || eventType === 'sandbox/mode' || eventType === 'approval/policy') {
      refreshMode()
    }
    if (eventType !== 'plan/mode' || (event.data as unknown as { active?: boolean }).active !== false) return
    const target = prePlanModes.get(session) ?? prePlanModeSpec(snapshotLiveSessionEvents(session))
    prePlanModes.delete(session)
    if (explicitPlanExits.delete(session) || target === undefined) return
    const queued = pendingPlanExitRestores.has(session)
    pendingPlanExitRestores.set(session, { capture, target })
    if (queued) return
    queueMicrotask(() => {
      const restore = pendingPlanExitRestores.get(session)
      pendingPlanExitRestores.delete(session)
      if (restore === undefined || !current(restore.capture) || session !== capturedSession(restore.capture) || foldPlanActive(snapshotLiveSessionEvents(session))) return
      // Shadow still projects the observed plan/mode event above, but never
      // schedules a compensating sandbox/approval write into the real log.
      if (runtime.mode === 'passive-shadow' || runtime.mode === 'replay-shadow') return
      applyMode(restore.target, restore.capture).catch(error => {
        ctx.logger.warn(`dsh-tui: plan-exit mode restore failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
  }

  return { refreshMode, cycleMode, applyMode, onSessionEvent }
}
