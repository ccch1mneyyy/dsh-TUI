import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isCommandCompletionToken } from '../../commands.js'
import {
  canonicalPresetFor,
  permissionCycleEntry,
  permissionModeSpec,
  stablePermissionRosterOrder,
  type SessionModeSpec,
} from '../../sessionModes.js'
import {
  permissionBundlesFromService,
  permissionPresetSnapshotFromService,
  type PermissionPresetBundle,
} from './permissions.js'
import type { PermissionPresetOption, PermissionPresetSnapshot } from './types.js'

/** Durable identities the configured modes already own; a runtime preset with
 *  one of them is the same switch by another route and never duplicated. */
export function configuredPermissionIds(modes: readonly SessionModeSpec[]): ReadonlySet<string> {
  return new Set(modes.flatMap(spec => spec.permission === undefined ? [] : [spec.permission]))
}

/** Canonical targets of the STATIC modes. On a stock table that is the three
 *  built-in names; on renamed tables the deployment's own names for the same
 *  bundles. They are never dynamic entries: the indicator would otherwise
 *  snap to a dynamic look-alike instead of the static mode. */
export function staticCanonicalTargets(
  modes: readonly SessionModeSpec[],
  bundles: readonly PermissionPresetBundle[],
): ReadonlySet<string> {
  const targets = new Set<string>()
  for (const spec of modes) {
    if (spec.permission !== undefined || spec.sandbox === undefined || spec.approval === undefined) continue
    const canonical = canonicalPresetFor(spec.sandbox, spec.approval, bundles)
    if (canonical !== undefined) targets.add(canonical)
  }
  return targets
}

/** The mounted `permissionPresets` registry as a runtime snapshot, or
 *  undefined when no runtime table is mounted (legacy/unavailable tables are
 *  not a roster). Reads are fail-closed: a throwing registry is no roster. */
export function readRuntimePermissionSnapshot(
  ctx: Context,
  target: Agent,
): PermissionPresetSnapshot | undefined {
  let service: unknown
  try {
    service = ctx.get('permissionPresets')
  } catch {
    return undefined
  }
  if (service === undefined) return undefined
  const snapshot = permissionPresetSnapshotFromService(service, target.session)
  return snapshot.availability === 'runtime' ? snapshot : undefined
}

/** Warn at most once per (agent, identity, reason) — a registry that keeps
 *  re-listing an unusable preset must not flood the log on every rebuild. */
export function warnOnceForPermissionEntry(
  warned: Set<string>,
  warn: (message: string) => void,
  target: Agent,
  value: string,
  reason: string,
): void {
  const key = `${String(target.id)}:${value}:${reason}`
  if (warned.has(key)) return
  if (warned.size >= 200) warned.clear()
  warned.add(key)
  warn(`dsh-tui: permission preset "${value}" skipped from Shift+Tab (${reason})`)
}

/** The Shift+Tab roster: configured modes first, runtime presets appended. */
export interface PermissionModeRoster {
  /** LIVE roster. The array identity is stable and mutated in place, so a
   *  consumer that captured it at construction always sees the latest
   *  roster after {@link PermissionModeRoster.rebuild}. */
  readonly modes: readonly SessionModeSpec[]
  /** Re-read the runtime preset registry for `target` and re-derive. */
  rebuild(target: Agent): void
  /** Runtime snapshot for `target`, undefined when no runtime table is mounted. */
  readSnapshot(target: Agent): PermissionPresetSnapshot | undefined
  /** Canonical preset name for one effective sandbox/approval bundle. */
  canonicalFor(
    sandbox: NonNullable<SessionModeSpec['sandbox']>,
    approval: NonNullable<SessionModeSpec['approval']>,
  ): string | undefined
}

/**
 * Dynamic session-mode roster (main's `sessionModes` / `rebuildSessionModes`).
 *
 * Runtime permission presets are appended AFTER the configured/default modes
 * whenever the SERVICE snapshot is usable — no dependency on the external
 * `/permission` command reaching this agent's registry, because switching
 * falls back to the service's own write path when the command row is absent.
 * Registry order is authoritative on first observation; later rebuilds
 * preserve the relative order of identities already seen so unrelated
 * command-registry churn cannot reshuffle Shift+Tab. Removed identities drop
 * out and a later re-add is treated as new.
 */
export function createPermissionModeRoster(
  ctx: Context,
  deps: {
    configuredModes: readonly SessionModeSpec[]
    agent: () => Agent
    warn?: (message: string) => void
  },
): PermissionModeRoster {
  const warn = deps.warn ?? ((message: string) => ctx.logger.warn(message))
  const configuredIds = configuredPermissionIds(deps.configuredModes)
  const warned = new Set<string>()
  const order = new WeakMap<object, readonly string[]>()
  // Mutated in place: a consumer that captured this array keeps observing the
  // live roster across rebuilds (see the interface contract).
  const modes: SessionModeSpec[] = [...deps.configuredModes]

  const bundlesOf = (): readonly PermissionPresetBundle[] => {
    let service: unknown
    try {
      service = ctx.get('permissionPresets')
    } catch {
      return []
    }
    return service === undefined ? [] : permissionBundlesFromService(service)
  }

  const canonicalFor = (
    sandbox: NonNullable<SessionModeSpec['sandbox']>,
    approval: NonNullable<SessionModeSpec['approval']>,
  ): string | undefined => canonicalPresetFor(sandbox, approval, bundlesOf())

  const rebuild = (target: Agent): void => {
    const snapshot = readRuntimePermissionSnapshot(ctx, target)
    const excluded = staticCanonicalTargets(deps.configuredModes, bundlesOf())
    const candidates = new Map<string, PermissionPresetOption>()
    if (snapshot !== undefined) {
      for (const option of snapshot.options) {
        if (excluded.has(option.value)) {
          warnOnceForPermissionEntry(warned, warn, target, option.value, 'canonical target')
          continue
        }
        if (!isCommandCompletionToken(option.value)) {
          warnOnceForPermissionEntry(warned, warn, target, option.value, 'unsafe command token')
          continue
        }
        const decision = permissionCycleEntry(option, configuredIds)
        if (!decision.accepted) {
          warnOnceForPermissionEntry(warned, warn, target, option.value, decision.reason)
          continue
        }
        candidates.set(option.value, option)
      }
    }
    const next = stablePermissionRosterOrder(
      order.get(target.session) ?? [],
      [...candidates.keys()],
    )
    order.set(target.session, next)
    const dynamic: SessionModeSpec[] = []
    for (const value of next) {
      const option = candidates.get(value)
      if (option !== undefined) dynamic.push(permissionModeSpec(option))
    }
    modes.length = 0
    for (const spec of [...deps.configuredModes, ...dynamic]) modes.push(spec)
  }

  // Main rebuilds once at construction, before the roster is first read.
  rebuild(deps.agent())

  return { modes, rebuild, readSnapshot: target => readRuntimePermissionSnapshot(ctx, target), canonicalFor }
}
