/**
 * `/plugin update [bundle ...]`: update installed registry bundles to their
 * latest compatible release.
 *
 * This is deliberately a thin layer over the host manager's own update API
 * (`listVersions` + `updateBundle`). The host owns the hard parts: it only
 * lists newer versions of an installed registry dependency, marks each release
 * as a bundle / deprecated / incompatible with the running DSH line, keeps the
 * bundle's selected state, and reinstalls the removed version when the target
 * fails. This module only chooses a safe target, drives the targets in order,
 * and writes the transcript.
 *
 * An empty target list means "all updatable bundles" — the form a person gets
 * from `/plugin update` — while names narrow it. Non-updatable entries (git,
 * path, official, or an installation-supplied bundle) are reported and skipped
 * rather than guessed at.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  BundleInfo,
  PluginInstallRequestId,
  PluginUpdateProgress,
  PluginUpdateResult,
  PluginVersion,
  PluginVersionList,
} from '@deepseek-ai/dsh-plugin-manager/types'
import { t } from '../i18n.js'
import { failureReasonOf } from './plugin-install.js'
import {
  extraBundles,
  newInstallRequestId,
  pluginManagerOf,
  pluginUpdateEvents,
  type PluginManagerView,
  type PluginUpdateEvents,
} from './plugin-manager.js'
import { cell, parsePluginArgs } from './plugins-info.js'

/** What only the UI knows about the update run. */
export interface PluginUpdateSink {
  /** The session the flow's output belongs to. */
  readonly binding: () => number
  /** Whether a turn is running; updating changes the profile under it. */
  readonly busy: () => boolean
  /** Where the transcript lines go. */
  readonly onLines: (lines: readonly string[]) => void
}

export interface PluginUpdateFlowOptions {
  readonly manager: PluginManagerView | undefined
  readonly events?: PluginUpdateEvents | undefined
  /** Bundle names, or empty for every updatable bundle. `all` is accepted too. */
  readonly targets: readonly string[]
  readonly binding: () => number
  readonly busy: () => boolean
  readonly onLines: (lines: readonly string[]) => void
  /** Injectable for a regression; a fresh process-unique id otherwise. */
  readonly nextRequestId?: (() => PluginInstallRequestId) | undefined
}

export interface PluginUpdateFlow {
  /** Resolve versions and update the selected bundles in order. Never rejects. */
  run(): Promise<void>
  /** Drop event subscriptions and later output; an in-flight host update still settles. */
  dispose(): void
}

/**
 * The version `/plugin update` should target: the newest usable release,
 * preferring the `latest` tag, then the newest non-prerelease. Deprecated
 * releases, versions that do not declare a bundle, and versions the running DSH
 * cannot load are never chosen. A prerelease outside `latest` is not an update
 * a person asked for.
 */
export function chooseUpdateVersion(versions: readonly PluginVersion[]): PluginVersion | undefined {
  const usable = versions.filter(version =>
    version.bundle && version.deprecated === undefined && version.incompatible === undefined)
  return usable.find(version => version.tags.includes('latest'))
    ?? usable.find(version => !version.prerelease)
}

function stepText(step: PluginUpdateProgress['step']): string {
  switch (step) {
    case 'checking': return t('plugins-update-step-checking')
    case 'removing': return t('plugins-update-step-removing')
    case 'installing': return t('plugins-update-step-installing')
    case 'restoring': return t('plugins-update-step-restoring')
  }
}

function textOf(error: unknown): string {
  return cell(error instanceof Error ? error.message : String(error))
}

export function createPluginUpdateFlow(options: PluginUpdateFlowOptions): PluginUpdateFlow {
  const bindingAtStart = options.binding()
  const nextRequestId = options.nextRequestId ?? newInstallRequestId
  let stopped = false
  let active: { readonly id: PluginInstallRequestId; readonly name: string } | undefined
  const disposers: Array<() => void> = []

  const live = (): boolean => !stopped && options.binding() === bindingAtStart
  const emit = (lines: readonly string[]): void => {
    if (lines.length === 0 || !live()) return
    options.onLines(lines)
  }

  if (options.events !== undefined) {
    disposers.push(options.events.onState((progress) => {
      const current = active
      if (current === undefined || progress.requestId !== current.id) return
      emit([t('plugins-update-progress', { name: cell(current.name), step: stepText(progress.step) })])
    }))
  }

  const dispose = (): void => {
    stopped = true
    active = undefined
    for (const unsubscribe of disposers.splice(0)) unsubscribe()
  }

  async function run(): Promise<void> {
    try {
      const manager = options.manager
      if (manager === undefined) {
        emit([t('plugins-service-unavailable')])
        return
      }
      // `listVersions` / `updateBundle` arrived after the oldest host line this
      // package still supports. Fail as a readable sentence, not a TypeError.
      if (typeof manager.listVersions !== 'function' || typeof manager.updateBundle !== 'function') {
        emit([t('plugins-update-unavailable')])
        return
      }
      if (options.busy()) {
        emit([t('plugins-update-busy')])
        return
      }

      let bundles: BundleInfo[]
      try {
        bundles = await manager.listBundles()
      } catch (error) {
        emit([t('plugins-service-error', { err: textOf(error) })])
        return
      }
      const installed = new Map(extraBundles(bundles).map(bundle => [bundle.name, bundle]))
      const all = options.targets.length === 0 || options.targets.includes('all')
      const selected: BundleInfo[] = []
      const counts = { updated: 0, current: 0, skipped: 0, failed: 0 }

      if (all) {
        for (const bundle of installed.values()) if (bundle.updatable) selected.push(bundle)
        if (selected.length === 0) {
          emit([t('plugins-update-none')])
          return
        }
      } else {
        const seen = new Set<string>()
        for (const name of options.targets) {
          if (seen.has(name)) continue
          seen.add(name)
          const bundle = installed.get(name)
          if (bundle === undefined) {
            counts.skipped += 1
            emit([t('plugins-update-skipped', { name: cell(name), reason: t('plugins-update-unknown') })])
            continue
          }
          if (!bundle.updatable) {
            counts.skipped += 1
            emit([t('plugins-update-skipped', { name: cell(name), reason: t('plugins-update-not-updatable') })])
            continue
          }
          selected.push(bundle)
        }
      }

      for (const bundle of selected) {
        if (stopped) break
        if (options.busy()) {
          emit([t('plugins-update-busy')])
          break
        }
        const name = bundle.name
        emit([t('plugins-update-checking', { name: cell(name) })])
        let list: PluginVersionList
        try {
          list = await manager.listVersions(name)
        } catch (error) {
          counts.failed += 1
          emit([t('plugins-update-failed', { name: cell(name), reason: textOf(error) })])
          continue
        }
        if (list.status === 'refused') {
          const failed = list.problem === 'network' || list.problem === 'unknown'
          if (failed) counts.failed += 1
          else counts.skipped += 1
          emit([t(failed ? 'plugins-update-failed' : 'plugins-update-skipped', {
            name: cell(name),
            reason: cell(list.reason),
          })])
          continue
        }
        const target = chooseUpdateVersion(list.versions)
        if (target === undefined) {
          if (list.versions.length === 0) {
            counts.current += 1
            emit([t('plugins-update-current', { name: cell(name), version: cell(list.installed) })])
          } else {
            counts.skipped += 1
            emit([t('plugins-update-no-compatible', { name: cell(name), version: cell(list.installed) })])
          }
          continue
        }

        emit([t('plugins-update-plan', {
          name: cell(name),
          from: cell(list.installed),
          to: cell(target.version),
        })])
        const requestId = nextRequestId()
        active = { id: requestId, name }
        let result: PluginUpdateResult
        try {
          result = await manager.updateBundle(name, target.version, {
            registry: list.registry,
            requestId,
          })
        } catch (error) {
          active = undefined
          counts.failed += 1
          emit([t('plugins-update-failed', { name: cell(name), reason: textOf(error) })])
          continue
        }
        active = undefined

        const outcome = result.result.application
        if (outcome === 'failed' || outcome === 'cancelled') {
          counts.failed += 1
          emit([t('plugins-update-failed', { name: cell(name), reason: cell(failureReasonOf(result.result)) })])
        } else if (outcome === 'restart-required') {
          counts.updated += 1
          emit([t('plugins-update-restart', {
            name: cell(name),
            reason: cell(result.result.restartReason ?? 'restart-required'),
          })])
        } else {
          counts.updated += 1
          emit([t('plugins-update-updated', {
            name: cell(name),
            from: cell(result.from),
            to: cell(result.to),
          })])
        }
        if (result.restore !== undefined) {
          const restore = result.restore
          if (restore.application === 'failed' || restore.application === 'cancelled') {
            emit([t('plugins-update-restore-failed', {
              name: cell(name),
              reason: cell(failureReasonOf(restore)),
            })])
          } else {
            emit([t('plugins-update-restored', { name: cell(name), version: cell(result.from) })])
          }
        }
      }

      if (selected.length > 0 || counts.skipped > 0 || counts.failed > 0) {
        emit([t('plugins-update-summary', {
          updated: String(counts.updated),
          current: String(counts.current),
          skipped: String(counts.skipped),
          failed: String(counts.failed),
        })])
      }
    } finally {
      // One-shot: a finished run must not keep an update-state subscription on
      // the context for the life of the process.
      dispose()
    }
  }

  return { run, dispose }
}

/** The `/plugin update` entry the screen calls. */
export function createPluginUpdateEntry(
  ctx: Context,
): (args: string, sink: PluginUpdateSink) => PluginUpdateFlow | undefined {
  return (args, sink) => {
    const parsed = parsePluginArgs(args)
    if (parsed.kind !== 'update') return undefined
    return createPluginUpdateFlow({
      manager: pluginManagerOf(ctx),
      events: pluginUpdateEvents(ctx),
      targets: parsed.targets,
      binding: sink.binding,
      busy: sink.busy,
      onLines: sink.onLines,
    })
  }
}
