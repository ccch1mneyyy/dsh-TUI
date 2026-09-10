/** In-process renderer capability, deliberately separate from JSON snapshots.
 * Every returned executable handle captures the same channel lifetime. No
 * handle can resolve a later registration or bypass policy through a factory.
 */

import type { HostEffectClass } from '../ports/owner.js'
import { assertShadowPolicy, type AdapterMode } from '../kernel/runtime.js'
import { completeCommands } from '../../commands.js'
import { createChannelReadView } from './read-view.js'
import { CHANNEL_UI_EFFECTS, CHANNEL_UI_PROPERTIES, type ChannelUi } from './ui-policy.js'

export interface ChannelUiLease {
  assertActive(): void
  own(dispose: () => void): () => void
}

function throwCleanupFailures(failures: unknown[], message: string): void {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, message)
}

export function createChannelUiLease(isCurrent: () => boolean): ChannelUiLease & { dispose(): void } {
  let active = true
  const disposers = new Set<() => void>()
  return {
    assertActive() {
      if (!active || !isCurrent()) throw new Error('dsh-tui: Channel UI lifetime has ended')
    },
    own(dispose) {
      let released = false
      const release = () => {
        if (released) return
        released = true
        disposers.delete(release)
        dispose()
      }
      if (!active || !isCurrent()) release()
      else disposers.add(release)
      return release
    },
    dispose() {
      if (!active) return
      active = false
      const failures: unknown[] = []
      for (const dispose of [...disposers]) {
        try { dispose() } catch (error) { failures.push(error) }
      }
      throwCleanupFailures(failures, 'dsh-tui: Channel UI cleanup failed')
    },
  }
}

/** The same factory is used by the kernel and bare production composition. */
export function createChannelUi(channel: ChannelUi, mode: AdapterMode, lease: ChannelUiLease): ChannelUi {
  const check = (effect: HostEffectClass) => {
    lease.assertActive()
    assertShadowPolicy(effect, mode)
  }
  const read = createChannelReadView(mutation => check(mutation ? 'mutate' : 'read-only'))
  const project = <T>(value: T): T => read(value, channel.version)
  const query = <T>(value: T): T => createChannelReadView(mutation => check(mutation ? 'mutate' : 'read-only'))(value, 0)
  const settle = <T>(value: T): T => {
    if (value instanceof Promise) return value.then(result => { check('read-only'); return query(result) }) as T
    return query(value)
  }
  function methods<T extends object>(target: T, effects: Readonly<Record<keyof T, HostEffectClass>>): T {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(effects) as (keyof T & string)[]) {
      const fn = target[key]
      if (typeof fn !== 'function') throw new Error(`dsh-tui: missing Channel handle method ${key}`)
      result[key] = (...args: unknown[]) => {
        check(effects[key])
        return settle(Reflect.apply(fn, target, args))
      }
    }
    return Object.freeze(result) as T
  }
  const view: Record<string, unknown> = {}
  for (const key of CHANNEL_UI_PROPERTIES) {
    Object.defineProperty(view, key, {
      enumerable: true,
      get() {
        check('read-only')
        if (key === 'subagentControl') return methods(channel.subagentControl, { interrupt: 'mutate' })
        if (key === 'jobControl') return channel.jobControl === undefined ? undefined : methods(channel.jobControl, { kill: 'mutate' })
        if (key === 'autoRecapOnOpen' && (mode === 'passive-shadow' || mode === 'replay-shadow')) return false
        if (key === 'pluginScene') {
          const scene = channel.pluginScene
          return scene === undefined ? undefined : project({ id: scene.id, title: scene.title })
        }
        return project(channel[key])
      },
    })
  }
  for (const key of Object.keys(CHANNEL_UI_EFFECTS) as (keyof typeof CHANNEL_UI_EFFECTS)[]) {
    view[key] = (...args: unknown[]) => {
      // Shadow probes may read the already-observed catalog/tier table, but
      // must not warm service caches or emit query-error notifications.
      if (mode === 'passive-shadow' || mode === 'replay-shadow') {
        if (key === 'commandCompletions') {
          check('read-only')
          return completeCommands(String(args[0] ?? ''), channel.commandList)
        }
        if (key === 'listEfforts') {
          check('read-only')
          return Promise.resolve({ efforts: (channel.effortLevels ?? []).map(id => ({ id, name: id })), defaultEffort: undefined })
        }
      }
      // A renderer observes the already-owned Channel emitter, never mounts
      // upstream service listeners. Keep this local observation distinct from
      // Host Port subscribe capabilities, whose shadow policy is unchanged.
      const observation = key === 'subscribe' || key === 'subscribeAgentView' || key === 'subscribeSettingsSections'
      check(observation ? 'read-only' : CHANNEL_UI_EFFECTS[key])
      const result = Reflect.apply(channel[key], channel, args)
      if (key === 'notify') {
        const timeout = (args[1] as { timeoutMs?: number } | undefined)?.timeoutMs ?? 4000
        let timer: ReturnType<typeof setTimeout> | undefined
        const release = lease.own(() => { if (timer !== undefined) clearTimeout(timer); result() })
        if (timeout > 0) timer = setTimeout(release, timeout)
        return release
      }
      if (observation) return lease.own(result)
      if (key === 'settingsHost' && result !== undefined) {
        return methods(result as NonNullable<ReturnType<ChannelUi['settingsHost']>>, {
          listNamespaces: 'read-only', credentialConfigured: 'read-only', write: 'mutate', writeCredential: 'mutate',
        })
      }
      if (key === 'providerSetup' && result !== undefined) {
        const host = result as NonNullable<ReturnType<ChannelUi['providerSetup']>>
        const { oauth, ...base } = host
        return Object.freeze({
          ...methods(base, {
            listCatalogProviders: 'read-only', listConfiguredProviders: 'read-only', listRefUsers: 'read-only',
            routeExists: 'read-only', envShadows: 'read-only', envValue: 'mutate', readCredential: 'mutate',
            discoverModels: 'mutate', writeCredential: 'mutate', removeCredential: 'mutate',
            writeProfile: 'mutate', mutateProfile: 'mutate', removeProfile: 'mutate',
          }),
          ...(oauth === undefined ? {} : { oauth: methods(oauth, { providers: 'read-only', login: 'mutate', logout: 'mutate' }) }),
        })
      }
      // The session event log is an append-only, JSON-safe read whose snapshot
      // array is replaced by the session on every append. Running it through
      // the detached read projection cost O(events) per call, and Chat folds
      // the trajectory from it on EVERY render: a long session (hundreds of
      // thousands of chunks) paid hundreds of milliseconds per frame while
      // streaming or scrolling — measured 322us @2k events, 2.7ms @20k,
      // 65ms @200k. The snapshot array is already frozen by the session, so
      // hand it back as-is; the lease/shadow `check()` above still gates the
      // call itself (same contract as before the Channel UI split).
      if (key === 'traceEvents') return result
      if (key === 'agentViewRows' || key === 'settingsSections') return project(result)
      return settle(result)
    }
  }
  return Object.freeze(view) as unknown as ChannelUi
}
