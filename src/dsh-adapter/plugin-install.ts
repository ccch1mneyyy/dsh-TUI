/**
 * `/plugin install <spec>`: the write half of the plugin command (Stage C-4).
 *
 * The flow owns the whole conversation with the host service — what a spec
 * names, gate 1's pre-install notice, gate 3's trust routing, pnpm's progress,
 * cancellation, the build-script approval, the version-exemption escape and
 * the final report — and it produces the transcript lines for all of it.
 *
 * What it does not do is ask. Every point where a person decides comes back as
 * a {@link PluginInstallStep}; the UI renders it and answers by calling the
 * next method. That keeps key handling where every other overlay keeps it
 * (`Chat.tsx`) and the domain here, and it lets a regression drive the whole
 * flow through a fake service without a terminal.
 *
 * Three rules the service's own semantics force:
 *
 * - `installBundle` resolves only once the run is over and the profile was
 *   restored or changed, so the promise IS the result. The service deletes a
 *   request the moment it settles, which makes `waitForInstall` a recovery path
 *   for a caller that lost the promise — not a mailbox to collect from, and not
 *   something this flow needs (it never lets go).
 * - A failure arrives in-band: the service folds every error into
 *   `application: 'failed'` with `result.error`. Only a lock or disposal error
 *   rejects, so the flow contains both shapes.
 * - Everything asynchronous is fenced to the binding that asked. A `/new` or a
 *   resume mid-install must not write pnpm output into the new session's
 *   transcript; the run itself is a profile-level operation and keeps going.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  ChangeResult,
  IncompatiblePlugin,
  InstallBundleOptions,
  InstallSpecKind,
  PluginInstallRequestId,
  PluginSpecInspection,
  Registry,
} from '@deepseek-ai/dsh-plugin-manager/types'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { t } from '../i18n.js'
import { installedTuiVersion, resolveDshProfileName } from '../update.js'
import { COMPOSITION_PACKAGE, type PluginInstallNotice } from './plugin-declaration.js'
import { type FirstPartyFeedLoad, firstPartyVerdict, type FirstPartyVerdict, loadFirstPartyFeed } from './plugin-feed.js'
import { newInstallRequestId, pluginInstallEvents, pluginManagerOf, type PluginInstallEvents, type PluginManagerView } from './plugin-manager.js'
import { cell, declarationNoticeFor, parsePluginArgs } from './plugins-info.js'

/** How many lines of pnpm's output the failure report keeps. */
export const INSTALL_LOG_TAIL = 6
/** Larger lines are discarded whole, rather than retaining a credential fragment. */
const INSTALL_LOG_LINE_BYTES = 16 * 1024

/** What a spec names, once the service has read it. */
export interface PluginArtifact {
  readonly name?: string | undefined
  readonly version?: string | undefined
  readonly kind: InstallSpecKind
  readonly bundle: boolean | null
  readonly registry: Registry
  readonly host?: string | undefined
}

/** What the profile's compatibility file currently exempts. */
export type VersionExemptions = ReturnType<PluginManagerView['listVersionExemptions']>

/** Stable display shape across the host's peers → requirements rename. */
export type IncompatiblePackage = Pick<IncompatiblePlugin, 'name' | 'version' | 'runtimeVersion'> & {
  readonly peers: Readonly<Record<string, string>>
}

/**
 * What `/plugin install` has to say next. `done` means the flow has reported
 * everything it is going to report: refused, finished, failed or cancelled.
 */
export type PluginInstallStep =
  | {
    readonly kind: 'confirm'
    readonly artifact: PluginArtifact
    /** Gate 3: whether the feed vouches for this exact artifact. */
    readonly trust: FirstPartyVerdict
    /** Gate 1: what could be read about the package's declarations, before it lands. */
    readonly notice: PluginInstallNotice
  }
  /** pnpm was blocked by build scripts this profile has not approved. */
  | { readonly kind: 'build-blocked'; readonly builds: readonly string[] }
  /** The running host refuses this exact version; the exemption is the escape. */
  | { readonly kind: 'incompatible'; readonly packages: readonly IncompatiblePackage[]; readonly exemptions: VersionExemptions }
  | { readonly kind: 'done' }

/** What the caller of a flow supplies that only the UI knows. */
export interface PluginInstallSink {
  /** The session the flow's output belongs to; see `binding` below. */
  readonly binding: () => number
  /** Whether a turn is running; see `busy` on the flow's options. */
  readonly busy: () => boolean
  /** Where the flow's transcript lines go (already sanitized and capped). */
  readonly onLines: (lines: readonly string[]) => void
}

export interface PluginInstallFlowOptions {
  readonly manager: PluginManagerView
  readonly spec: string
  /** The feed the trust verdict reads (loaded once by the caller). */
  readonly feed: FirstPartyFeedLoad
  /** Gate 1's evidence for one target; `declarationNoticeFor` in the wiring. */
  readonly noticeOf: (target: { readonly name?: string | undefined; readonly directory?: string | undefined }) => PluginInstallNotice
  /** Resolve a path spec to a directory, when the caller knows the profile root. */
  readonly specDirectory?: ((spec: string) => string | undefined) | undefined
  /** The binding generation that asked; every asynchronous write is fenced to it. */
  readonly binding: () => number
  /**
   * Whether a turn is running. Installing changes the profile, and the change
   * applies or reloads plugins under whatever is running, so the flow refuses
   * while this is true — before the inspection, and again before the write.
   */
  readonly busy: () => boolean
  /** Where the flow's transcript lines go (already sanitized and capped). */
  readonly onLines: (lines: readonly string[]) => void
  /** The manager's install events, when the caller has a context to subscribe on. */
  readonly events?: PluginInstallEvents | undefined
  /** This package's running version — the other side of the drift check. */
  readonly ownVersion?: string | undefined
  /** The profile an installation belongs to, for the manual commands. */
  readonly profileName?: string | undefined
  /** The registry asked first. */
  readonly registry?: Registry | undefined
  /** Injectable for a regression; a fresh process-unique id otherwise. */
  readonly requestId?: PluginInstallRequestId | undefined
}

export interface PluginInstallFlow {
  readonly requestId: PluginInstallRequestId
  /** Read the spec, judge it, and either ask (gate 1 / gate 3) or install straight away. */
  begin(): Promise<PluginInstallStep>
  /** Answer a `confirm` step: proceed. */
  confirm(): Promise<PluginInstallStep>
  /** Answer a `build-blocked` step: allow these scripts and retry. */
  approve(builds: readonly string[]): Promise<PluginInstallStep>
  /** Answer an `incompatible` step: exempt these exact versions and retry. */
  acceptRisk(): Promise<PluginInstallStep>
  /** Stop pending work and await profile writes already started; repeated calls share the wait. */
  cancel(): Promise<PluginInstallStep>
  /** Release the event subscriptions. */
  dispose(): void
}

/**
 * The reason line for a result that failed, from the most specific field it
 * carries. Exported because the lifecycle flow (`./plugin-manage.ts`) writes
 * through the same `change()` funnel and reports the same shapes — and because
 * the credential reasoning below is exactly the kind of rule that must not exist
 * in two copies: a removal runs pnpm too.
 */
export function failureReasonOf(result: ChangeResult): string {
  const error = result.error
  if (error !== undefined) {
    // A failed package run repeats its byte-limited, interleaved capture in the
    // diagnostic. It can start halfway through a credential-bearing URL; only
    // the per-stream event lines are safe evidence. Activation errors after a
    // successful run, and operations without a package run, keep their details.
    const failedPackageRun = result.packageResult !== undefined
      && (result.packageResult.exitCode !== 0 || result.packageResult.timedOut === true)
    const diagnostic = failedPackageRun ? undefined : error.diagnostic
    return diagnostic === undefined ? error.code : `${error.code} — ${cell(diagnostic)}`
  }
  if (result.packageResult?.kind !== undefined) return result.packageResult.kind
  if (result.failedAt !== undefined) return result.failedAt
  return 'unknown'
}

/**
 * The version the person wrote in the spec, exactly as written — `undefined`
 * when the spec names no version. A bare name is resolved to "latest" at
 * install time, which is not the artifact the feed pinned: that is a
 * `version-mismatch`, not a hit (`tui-profile/feed/README.md`).
 *
 * The name comes from the inspection rather than from a spec grammar of our
 * own, so every form this cannot read — an alias, a git or tarball spec —
 * yields `undefined`, a verdict that can only fall to third-party. Fail closed.
 */
function writtenVersionOf(spec: string, name: string | undefined): string | undefined {
  if (name === undefined || !spec.startsWith(`${name}@`)) return undefined
  return spec.slice(name.length + 1)
}

/**
 * The spec the service is actually asked to install: the exact `name@version`
 * the inspection read, for a registry package. A bare name, a tag or a range
 * would be resolved again by the install — and again by a retry — so the
 * artifact that lands could be one nobody inspected, judged or confirmed. A
 * path, git or tarball spec has no registry version to pin and is installed as
 * typed.
 */
function installSpecOf(read: PluginArtifact, spec: string): string {
  return read.kind === 'registry' && read.name !== undefined && read.version !== undefined
    ? `${read.name}@${read.version}`
    : spec
}

export function createPluginInstallFlow(options: PluginInstallFlowOptions): PluginInstallFlow {
  const requestId = options.requestId ?? newInstallRequestId()
  const bindingAtStart = options.binding()
  /** The artifact `inspect()` read; a retry installs the same one. */
  let artifact: PluginArtifact | undefined
  /** Build scripts approved for this run, carried across a retry. */
  let approvedBuilds: readonly string[] | undefined
  /** What the last incompatible failure named, for `acceptRisk()`. */
  let incompatible: readonly IncompatiblePlugin[] = []
  /** The lines of pnpm output kept for a failure report. */
  const logTail: string[] = []
  let stopped = false
  /** Writes already handed to the service: cancellation must await their settlement. */
  let activeInstall: Promise<ChangeResult> | undefined
  let activeExemption: Promise<ChangeResult> | undefined
  /**
   * The one cancellation in flight. A repeated Esc waits for the same rollback
   * rather than reporting the flow over: the service has a single request to
   * stop, and a `done` that arrives before the profile is back would let the
   * screen close the pane over work that is still going on.
   */
  let cancelling: Promise<PluginInstallStep> | undefined
  const disposers: Array<() => void> = []

  /** Whether the session that asked is still bound; false drops every write. */
  const live = (): boolean => options.binding() === bindingAtStart
  const emit = (lines: readonly string[]): void => {
    if (lines.length === 0 || !live()) return
    options.onLines(lines)
  }
  const tailLines = (): string[] => logTail.map(line => `  ${line}`)
  /**
   * A turn is running: nothing is asked and no service is called. Checked at
   * both ends of the wait — before the inspection, and again before the write —
   * because a turn can start while the pane is waiting for an answer.
   */
  function refuseWhileBusy(): PluginInstallStep | undefined {
    if (!options.busy()) return undefined
    emit([t('plugins-install-busy')])
    return { kind: 'done' }
  }

  /**
   * pnpm's output arrives chunk by chunk, and a URL's credentials can straddle
   * two of them: a line is evidence only once it is whole, because the one
   * renderer that strips them (`redactText`) reads URLs, and a fragment that
   * lost its `scheme://user:` head is not one. Lines are assembled per job and
   * stream. Over-budget lines are discarded through their next newline, with a
   * notice in the tail: slicing them could expose a credential fragment. A
   * bounded unfinished line is settled once the run is over.
   */
  // null means this stream is discarding an oversized line until its newline.
  const partials = new Map<string, { text: string; bytes: number } | null>()
  const pushLogLine = (line: string): void => {
    const text = cell(line)
    if (text.trim() === '') return
    logTail.push(text)
    while (logTail.length > INSTALL_LOG_TAIL) logTail.shift()
  }
  const flushLogTail = (): void => {
    for (const rest of partials.values()) if (rest !== null) pushLogLine(rest.text)
    partials.clear()
  }

  if (options.events !== undefined) {
    disposers.push(options.events.onState(requestId, progress => {
      if (progress.phase === 'installing' && progress.attempt !== undefined) {
        emit([t('plugins-install-attempt', {
          index: String(progress.attempt.index),
          total: String(progress.attempt.total),
          registry: cell(progress.attempt.registry ?? ''),
        })])
        return
      }
      emit([t(progress.phase === 'cancelling'
        ? 'plugins-install-cancelling'
        : progress.phase === 'applying' ? 'plugins-install-applying' : 'plugins-install-installing')])
    }))
    // Raw pnpm output is noise on a working install and the only evidence on a
    // failed one: keep the last lines and report them with the failure.
    disposers.push(options.events.onLog(requestId, chunk => {
      const key = `${chunk.jobId}\u0000${chunk.stream}`
      let partial = partials.get(key)
      if (partial === undefined) partial = { text: '', bytes: 0 }
      const parts = chunk.text.split('\n')
      for (const [index, part] of parts.entries()) {
        if (partial !== null) {
          const bytes = Buffer.byteLength(part)
          if (partial.bytes + bytes > INSTALL_LOG_LINE_BYTES) {
            partial = null
            pushLogLine(t('plugins-install-log-line-omitted', { bytes: String(INSTALL_LOG_LINE_BYTES) }))
          } else {
            partial.text += part
            partial.bytes += bytes
          }
        }
        if (index < parts.length - 1) {
          if (partial !== null) pushLogLine(partial.text)
          partial = { text: '', bytes: 0 }
        }
      }
      if (partial !== null && partial.text === '') partials.delete(key)
      else partials.set(key, partial)
    }))
  }

  /** Read the spec; report and answer `undefined` when it is not installable. */
  async function inspect(): Promise<PluginArtifact | undefined> {
    let inspection: PluginSpecInspection
    try {
      inspection = await options.manager.inspect(
        options.spec,
        options.registry === undefined ? undefined : { registry: options.registry },
      )
    } catch (error) {
      emit([t('plugins-install-failed', { reason: cell(error instanceof Error ? error.message : String(error)) })])
      return undefined
    }
    if (inspection.status === 'refused') {
      emit([t('plugins-info-inspect-refused', { problem: inspection.problem, reason: cell(inspection.reason) })])
      return undefined
    }
    const read: PluginArtifact = {
      name: inspection.name,
      version: inspection.version,
      kind: inspection.kind,
      bundle: inspection.bundle,
      registry: inspection.registry,
      host: inspection.host,
    }
    artifact = read
    emit([t('plugins-install-inspect', {
      spec: cell(inspection.name === undefined
        ? options.spec
        : `${inspection.name}${inspection.version === undefined ? '' : `@${inspection.version}`}`),
      kind: read.kind,
      bundle: read.bundle === true ? 'bundle' : read.bundle === false ? 'not a bundle' : 'unknown',
    })])
    return read
  }

  /** Gate 3's routing and gate 1's notice: ask, or go on when nothing is askable. */
  function route(read: PluginArtifact): PluginInstallStep {
    // The kind is part of the question: only a registry artifact can be the
    // published one the feed lists (a directory or git checkout is read from
    // the manifest it ships, so it would vouch for itself).
    // The feed vouches for one exact artifact, so what it judges is the version
    // the person WROTE — not the one the registry resolved: a bare name means
    // "latest" at install time, which is not the pinned artifact, and a range or
    // a tag is not one either (`tui-profile/feed/README.md`).
    const trust = firstPartyVerdict(options.feed, {
      name: read.name,
      version: writtenVersionOf(options.spec, read.name),
      kind: read.kind,
    })
    if (trust.kind === 'first-party') {
      emit([t('plugins-install-trusted', { name: cell(trust.entry.name), version: cell(trust.entry.version) })])
    }
    const notice = options.noticeOf({
      name: read.name,
      directory: options.specDirectory?.(options.spec),
    })
    // Gate 1 is a notice, never a veto: it is shown whenever it has something to
    // say. A first-party package with a readable, accepted declaration is the one
    // case with nothing to ask about — that is what skipping the trust
    // confirmation means. It does not skip the ledger or the list.
    if (trust.kind === 'first-party' && notice.kind === 'declared') return { kind: 'done' }
    return { kind: 'confirm', artifact: read, trust, notice }
  }

  /**
   * The profile's current exemptions. `listVersionExemptions()` is the one
   * service call that answers synchronously, so it is also the one that can
   * throw past a `catch` on a promise: read it defensively and say so, because
   * the pane shows what it returns.
   */
  function exemptionsNow(): VersionExemptions {
    try {
      return options.manager.listVersionExemptions()
    } catch (error) {
      emit([t('plugins-install-exemptions-unreadable', { reason: cell(error instanceof Error ? error.message : String(error)) })])
      return { exemptions: {}, warnings: [] }
    }
  }

  /** Install, then turn the service's own result into the next step. */
  async function run(): Promise<PluginInstallStep> {
    const read = artifact
    // A person who closed the pane while the spec was still being read has not
    // asked for this install: the inspection's answer must not start one.
    if (read === undefined || stopped) return { kind: 'done' }
    // The write is the point of no return, and a turn may have started while the
    // pane waited for an answer: re-check here, not only at `begin()`.
    const refused = refuseWhileBusy()
    if (refused !== undefined) return refused
    const installSpec = installSpecOf(read, options.spec)
    let result: ChangeResult
    try {
      const installOptions: InstallBundleOptions = {
        requestId,
        ...options.registry === undefined ? {} : { registry: options.registry },
        ...approvedBuilds === undefined ? {} : { approvedBuilds: [...approvedBuilds] },
      }
      activeInstall = options.manager.installBundle(installSpec, installOptions)
      result = await activeInstall
    } catch (error) {
      emit([t('plugins-install-failed', { reason: cell(error instanceof Error ? error.message : String(error)) })])
      return { kind: 'done' }
    } finally {
      activeInstall = undefined
      // The run is over: whatever its last chunk left unfinished is whole now.
      flushLogTail()
    }
    // An approval the service accepted is spent. It is written into the profile
    // before pnpm runs and echoed back as `result.approvedBuilds`, and offering
    // it again is refused as `stale-approval` — which would make the retry after
    // an `incompatible` failure impossible. The service writes every name or
    // none (`stale-approval` aborts the batch), so consuming what it echoed is
    // the same as dropping the batch. A rejected call leaves `result` undefined
    // and keeps them: nothing landed, and that path has no retry.
    if (result.approvedBuilds !== undefined) approvedBuilds = undefined
    // The cancel path reports itself; an install that ends `cancelled` after it
    // must not report a second, contradictory ending.
    if (result.application === 'cancelled') return { kind: 'done' }
    const builds = result.pendingBuilds ?? []
    if (builds.length > 0) {
      emit([t('plugins-install-build-blocked', { count: String(builds.length) })])
      return { kind: 'build-blocked', builds }
    }
    if (result.application === 'failed') {
      incompatible = result.error?.code === 'incompatible-version' ? result.error.incompatible ?? [] : []
      if (incompatible.length > 0) {
        emit([t('plugins-install-incompatible', {
          packages: incompatible.map(entry => `${cell(entry.name)}@${cell(entry.version)}`).join(', '),
          runtime: cell(incompatible[0]?.runtimeVersion ?? ''),
        })])
        const packages = incompatible.map(entry => {
          const shape = entry as IncompatiblePlugin & { requirements?: Record<string, string>; peers?: Record<string, string> }
          return { name: entry.name, version: entry.version, runtimeVersion: entry.runtimeVersion, peers: shape.requirements ?? shape.peers ?? {} }
        })
        return { kind: 'incompatible', packages, exemptions: exemptionsNow() }
      }
      emit([
        t('plugins-install-failed', { reason: failureReasonOf(result) }),
        ...tailLines(),
        t('plugins-install-manual', { profile: cell(options.profileName ?? 'dsh-tui'), spec: cell(installSpec) }),
        t('plugins-install-rescue'),
      ])
      return { kind: 'done' }
    }
    const bundle = result.bundle ?? read.name ?? options.spec
    const stateKey = result.application === 'restart-required'
      ? 'plugins-install-state-restart'
      : result.application === 'overridden' ? 'plugins-install-state-overridden' : 'plugins-install-state-applied'
    emit([
      t('plugins-install-done', { bundle: cell(bundle), state: t(stateKey) }),
      ...result.application === 'restart-required' ? [t('plugins-install-restart-hint')] : [],
    ])
    await reportDrift()
    return { kind: 'done' }
  }

  /**
   * The #1340 drift check: installing a plugin must not move this application's
   * own version behind its back. Detected and reported, never repaired — the fix
   * is a command a person runs.
   */
  async function reportDrift(): Promise<void> {
    const running = options.ownVersion
    if (running === undefined) return
    let bundles
    try {
      bundles = await options.manager.listBundles()
    } catch {
      return
    }
    const own = bundles.find(bundle => bundle.name === COMPOSITION_PACKAGE)
    if (own?.version === undefined || own.version === running) return
    emit([t('plugins-install-drift', {
      name: COMPOSITION_PACKAGE,
      found: cell(own.version),
      running: cell(running),
      profile: cell(options.profileName ?? 'dsh-tui'),
    })])
  }

  /** Grant the exact-version exemptions the last failure named, then retry. */
  async function riskAndRetry(): Promise<PluginInstallStep> {
    if (incompatible.length === 0 || stopped) return { kind: 'done' }
    const packages = [...incompatible]
    let recorded = 0
    try {
      for (const entry of packages) {
        if (stopped) break
        // Granting an exemption writes and reloads the profile, just like an
        // install. A turn can start while the pane, or the previous write, waits.
        const refused = refuseWhileBusy()
        if (refused !== undefined) {
          if (recorded > 0) emit([t('plugins-install-exempted', { count: String(recorded) })])
          return refused
        }
        // A refusal is in-band (`application: 'failed'`): a stale runtime
        // version, an unrepairable compatibility file, a missing --accept-risk.
        // Reporting it as granted and retrying would send the person in a loop
        // that cannot succeed.
        activeExemption = options.manager.setVersionExemption(`${entry.name}@${entry.version}`, entry.runtimeVersion, true, true)
        const outcome = await activeExemption
        activeExemption = undefined
        if (outcome.application === 'failed') {
          emit([t('plugins-install-failed', { reason: failureReasonOf(outcome) })])
          return { kind: 'done' }
        }
        recorded += 1
      }
    } catch (error) {
      emit([t('plugins-install-failed', { reason: cell(error instanceof Error ? error.message : String(error)) })])
      return { kind: 'done' }
    } finally {
      activeExemption = undefined
    }
    if (recorded > 0) emit([t('plugins-install-exempted', { count: String(recorded) })])
    if (stopped) return { kind: 'done' }
    incompatible = []
    return run()
  }

  return {
    requestId,
    async begin() {
      const refused = refuseWhileBusy()
      if (refused !== undefined) return refused
      const read = await inspect()
      if (read === undefined) return { kind: 'done' }
      // The read can take a moment (a registry round trip): a cancel that lands
      // while it is in flight stops the flow here, before anything is asked or
      // installed.
      if (stopped) return { kind: 'done' }
      const step = route(read)
      return step.kind === 'confirm' ? step : run()
    },
    async confirm() {
      return stopped ? { kind: 'done' } : run()
    },
    async approve(builds) {
      if (stopped) return { kind: 'done' }
      approvedBuilds = builds
      emit([t('plugins-install-build-approved', { count: String(builds.length) })])
      return run()
    },
    async acceptRisk() {
      return stopped ? { kind: 'done' } : riskAndRetry()
    },
    async cancel() {
      // A cancel already in flight is the answer to this one too: answering it
      // here would settle the flow (and let the pane close) before the profile
      // is back. Checked first, because `stopped` is already set by then.
      if (cancelling !== undefined) return cancelling
      // Already stopped, with nothing in flight: a second Esc must not ask
      // again (the first answer is the one that gets reported).
      if (stopped) return { kind: 'done' }
      stopped = true
      const install = activeInstall
      const pending = install ?? activeExemption
      // Inspection and waiting for an answer have no profile write to settle.
      if (pending === undefined) return { kind: 'done' }
      cancelling = (async (): Promise<PluginInstallStep> => {
        if (install !== undefined) {
          try {
            const outcome = await options.manager.cancelInstall(requestId)
            emit([t(outcome.status === 'cancelled'
              ? 'plugins-install-cancelled'
              : outcome.status === 'too-late' ? 'plugins-install-cancel-too-late' : 'plugins-install-cancel-not-running')])
          } catch (error) {
            emit([t('plugins-install-cancel-failed', { reason: cell(error instanceof Error ? error.message : String(error)) })])
          }
        }
        // `too-late`, `not-running` and a rejected cancellation do not settle
        // the owned write. Its original caller reports any failure.
        await pending.then(() => undefined, () => undefined)
        return { kind: 'done' }
      })()
      return cancelling
    },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose()
      partials.clear()
    },
  }
}

/**
 * The `/plugin install` entry the screen calls: `/plugin`'s argument text in, a
 * flow out — or `undefined` for anything that is not an install form, and for a
 * launch with no profile plugin service to install through (the screen then
 * runs the read-only report, which is where the CLI route is printed).
 *
 * This is the one place that knows how the flow is wired to the running
 * composition: the host service and its events, the packaged feed, gate 1's
 * declaration reader, and the profile-relative resolution of a `install <path>`
 * spec. It lives beside the flow rather than in the entry so a regression can
 * drive the real wiring with a fixture context — the parts that only exist here
 * (the feed load, the declaration read, the `file:` base URL) are exactly the
 * ones a fixture-only battery would otherwise never touch.
 */
export function createPluginInstallEntry(
  ctx: Context,
  options: { readonly profileName?: string | undefined; readonly ownVersion?: string | undefined } = {},
): (args: string, sink: PluginInstallSink) => PluginInstallFlow | undefined {
  return (args, sink) => {
    const parsed = parsePluginArgs(args)
    if (parsed.kind !== 'install' || parsed.spec === '') return undefined
    const manager = pluginManagerOf(ctx)
    if (manager === undefined) return undefined
    return createPluginInstallFlow({
      manager,
      events: pluginInstallEvents(ctx),
      spec: parsed.spec,
      // Read once per install: the feed is a packaged file, and a request that is
      // never made should never touch the disk.
      feed: loadFirstPartyFeed(),
      // Gate 1 reads the directory THIS spec names. A declaration resolved by
      // name would be the profile's already-installed copy of that name — a
      // different artifact from the one being installed (another version, or a
      // local directory), so it is no evidence about this target.
      noticeOf: target => declarationNoticeFor(target.directory === undefined ? {} : { directory: target.directory }),
      specDirectory: spec => specDirectoryOf(spec),
      binding: sink.binding,
      busy: sink.busy,
      onLines: sink.onLines,
      ownVersion: options.ownVersion ?? installedTuiVersion(),
      profileName: options.profileName ?? resolveDshProfileName(),
    })
  }
}

/**
 * The directory a `install <path>` spec names, when it names one. Only a
 * directory has a package-root declaration to read — a tarball or git spec must
 * stay unjudged rather than be reported as "declares nothing".
 *
 * A path spec must be absolute: that is the service's own contract ("a local
 * path must be absolute"), and a relative one is refused as `invalid-spec`
 * before any of this matters, so there is no profile-relative resolution to do
 * here. The one thing left to normalize is pnpm's `file:` / `link:` prefix,
 * which names the same directory and must not lose its declaration evidence.
 */
function specDirectoryOf(spec: string): string | undefined {
  const path = spec.replace(/^(?:file|link):/u, '')
  if (!isAbsolute(path)) return undefined
  try {
    return statSync(path).isDirectory() ? path : undefined
  } catch {
    return undefined
  }
}
