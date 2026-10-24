/**
 * `/plugin remove | enable | disable`: the lifecycle half of the plugin
 * command (Stage C-5).
 *
 * The flow owns the whole conversation with the host service — resolving what
 * the argument names against one snapshot, asking gate 2 whether this
 * application may touch it at all, deciding whether the action is one a person
 * has to confirm, writing through the service and reporting what happened — and
 * it produces the transcript lines for all of it, exactly like the install flow
 * beside it (`./plugin-install.ts`).
 *
 * Four rules shape it:
 *
 * - **Gate 2 runs before anything else, and a refusal makes no service call.**
 *   It is the only line between the host's addressable rows and this application
 *   switching itself off; a refusal carries the rule it broke, so the caller
 *   prints a reason instead of greying a target out.
 * - **Nothing is guessed.** A target is a bundle name, an `entryId`, a
 *   `patchId` or a `moduleName`, matched against one `listBundles()` +
 *   `listPlugins()` read. A bundle name wins over a row identity, because the
 *   two levels mean different things (a bundle is a composition layer, a row is
 *   one entry of one) and a name that is both must not quietly become the
 *   smaller action. A target nothing matches is reported with what *is*
 *   addressable — never resolved by prefix, case or fuzzy match.
 * - **The outcome is what the profile did, not what was asked.** These actions
 *   go through the same `change()` funnel as an installation: `changed` says
 *   whether the profile's files really moved, `application` says whether the
 *   running host took it, and a failure arrives in-band. A write that changed
 *   nothing is not dressed up as a success.
 * - **Every asynchronous write is fenced to the binding that asked.** A `/new`
 *   or a resume mid-write must not drop the result into the new session's
 *   transcript. There is no cancellation surface here — the service offers none
 *   for these actions, and each is a profile-level operation that finishes
 *   either way, so closing the pane does not stop it.
 */
import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { BundleInfo, ChangeResult, PluginEntryId, PluginInfo } from '@deepseek-ai/dsh-plugin-manager/types'
import { t, type I18nKey } from '../i18n.js'
import { resolveDshProfileName } from '../update.js'
import { backendDataDir, DATA_DIR } from '../utils/paths.js'
import { COMPOSITION_PACKAGES, declaredBackendsOf, pluginDeclarationOf } from './plugin-declaration.js'
import { failureReasonOf } from './plugin-install.js'
import {
  HOST_BUNDLE,
  type PluginGuardAction,
  pluginGuardVerdict,
  type PluginGuardRefusal,
  type PluginGuardTarget,
} from './plugin-guard.js'
import { pluginManagerOf, type PluginManagerView } from './plugin-manager.js'
import { cell, parsePluginArgs, pluginFootprintContains } from './plugins-info.js'
import { TEAM_BUNDLE } from './team-roster.js'

/** The three lifecycle actions. */
export type PluginManageAction = PluginGuardAction

/**
 * One target, once it is known. What it carries is what a report or a
 * confirmation pane needs; what gate 2 reads (`removable`, `readOnlyReason`) is
 * read from the snapshot where the decision is made rather than copied in, so
 * the two cannot disagree about one record.
 */
export type PluginManageTarget =
  | {
    readonly action: PluginManageAction
    readonly kind: 'bundle'
    readonly name: string
    /** The installed version, when the profile knows one. */
    readonly version?: string | undefined
    /** The rows the bundle's patch inserts, and the rows it overrides. */
    readonly rows: number
    readonly overrides: number
  }
  | {
    readonly action: PluginManageAction
    readonly kind: 'row'
    readonly entryId: PluginEntryId
    readonly moduleName: string
    /** The patch row this entry is addressable as, when it is. */
    readonly patchId?: string | undefined
    /** Whether the entry is running now, before the action. */
    readonly enabled: boolean
  }

/**
 * Teammates the team-off question names: known to be running or
 * provisioning (`active`), and those whose run a teammate session cannot see
 * (`unseen`).
 */
export interface TeamActiveMembers {
  readonly active: number
  readonly unseen: number
}

const NO_TEAM_MEMBERS: TeamActiveMembers = { active: 0, unseen: 0 }

/**
 * What the action asks a person, when it asks. Which question it is decides the
 * wording and the risk it names; all three end in the same write.
 */
export type PluginManageQuestion =
  /** `remove` of a bundle: destructive, and the profile's own files change. */
  | { readonly kind: 'remove' }
  /** `enable`: the host does not attest the installed code's source. */
  | { readonly kind: 'trust' }
  /**
   * `disable` of a row the host layer owns: the entry belongs to `dsh-base`, so
   * switching it off unloads services this application injects.
   */
  | { readonly kind: 'host-row' }
  /**
   * `disable` of the Agent Teams bundle while teammates run, are being
   * created, or may be running unseen (`unseen`, from a teammate session):
   * the team service stops them as it unloads, so the person decides with
   * that in view.
   */
  | { readonly kind: 'team-active'; readonly members: number; readonly unseen: number }

/**
 * What `/plugin remove|enable|disable` has to say next. `done` means the flow
 * has reported everything it is going to report: refused, finished or failed.
 */
export type PluginManageStep =
  | { readonly kind: 'confirm'; readonly target: PluginManageTarget; readonly question: PluginManageQuestion }
  | { readonly kind: 'done' }

/** What the caller of a flow supplies that only the UI knows. */
export interface PluginManageSink {
  /** The session the flow's output belongs to; see `binding` below. */
  readonly binding: () => number
  /** Whether a turn is running; see `busy` on the flow's options. */
  readonly busy: () => boolean
  /** Where the flow's transcript lines go (already sanitized and capped). */
  readonly onLines: (lines: readonly string[]) => void
  /** See `teamActiveMembers` on the flow's options. */
  readonly teamActiveMembers?: (() => TeamActiveMembers) | undefined
}

/**
 * What one removal left behind, asked **after** the write succeeded.
 * `undefined` means "not judged": the wiring had no declaration to read the
 * bundle's own identities from, and that is reported rather than passed off as
 * "nothing left". An empty array means "judged, and it left nothing", which is
 * not worth a line.
 */
export type PluginResidueWatch = () => readonly string[] | undefined

export interface PluginManageFlowOptions {
  readonly manager: PluginManagerView
  readonly action: PluginManageAction
  /** The argument text after the subcommand: a bundle name or a row identity. */
  readonly target: string
  /** The binding generation that asked; every asynchronous write is fenced to it. */
  readonly binding: () => number
  /**
   * Whether a turn is running. These actions rewrite the profile and apply or
   * reload plugin layers under whatever is running, so the flow refuses while
   * this is true — before the resolution, and again before the write.
   */
  readonly busy: () => boolean
  /** Where the flow's transcript lines go (already sanitized and capped). */
  readonly onLines: (lines: readonly string[]) => void
  /** The profile an action belongs to, for the manual commands. */
  readonly profileName?: string | undefined
  /**
   * The footprint one removal would leave behind. The wiring reads the bundle's
   * package-root declaration while it is still installed and closes over it,
   * which is why the whole watch is handed over before the write and only
   * consulted after it.
   */
  readonly residueOf?: ((name: string) => PluginResidueWatch | undefined) | undefined
  /**
   * Teammates of the bound session that are running or provisioning, and
   * those that may be running. Read when `disable` resolves to the Agent
   * Teams bundle; absent reads as none.
   */
  readonly teamActiveMembers?: (() => TeamActiveMembers) | undefined
}

export interface PluginManageFlow {
  /** Resolve the target, run gate 2, and either ask or write straight away. */
  begin(): Promise<PluginManageStep>
  /** Answer a `confirm` step: proceed with the write. */
  confirm(): Promise<PluginManageStep>
  /**
   * Release anything the flow holds. Nothing today, and deliberately not a stop
   * button: these three actions have no cancellation, and a write already handed
   * to the service settles on its own (the install flow's `dispose` is the same
   * shape, plus the subscriptions it really does hold).
   */
  dispose(): void
}

/**
 * What gate 2's refusal says. A table rather than a composed key: an i18n key
 * has to be a literal somebody can find, or the wording of a refusal becomes
 * invisible to the dictionary gate that would catch a missing translation.
 */
const REFUSAL_KEYS: Record<PluginGuardRefusal, I18nKey> = {
  'service-locked': 'plugins-manage-refused-service-locked',
  'app-bundle': 'plugins-manage-refused-app-bundle',
  'host-bundle': 'plugins-manage-refused-host-bundle',
  'not-removable': 'plugins-manage-refused-not-removable',
  'row-not-removable': 'plugins-manage-refused-row-not-removable',
  'app-row': 'plugins-manage-refused-app-row',
}

/** What an action's own success line calls itself. */
const APPLIED_KEYS: Record<PluginManageAction, I18nKey> = {
  remove: 'plugins-manage-removed',
  enable: 'plugins-manage-enabled',
  disable: 'plugins-manage-disabled',
}

/**
 * The manual route for a failure, by what the service was asked to do.
 *
 * The CLI has `add` and `remove` and nothing else: enablement is written into
 * the profile's own files (the manifest's `dsh.profile.bundles`,
 * `cordis.patch.yml`'s `disabled`), so for those two the way through is the
 * profile this application runs on — not a command that does not exist. Handing
 * somebody an `enable` verb the CLI rejects would be worse than saying nothing.
 */
function manualKeyOf(action: PluginManageAction): I18nKey {
  return action === 'remove' ? 'plugins-manage-manual-remove' : 'plugins-manage-manual-profile'
}

/** One bundle as a target, from the record the snapshot carried. */
function bundleTarget(action: PluginManageAction, bundle: BundleInfo): PluginManageTarget {
  return {
    action,
    kind: 'bundle',
    name: bundle.name,
    version: bundle.version,
    rows: bundle.rows.length,
    overrides: bundle.overrides.length,
  }
}

/** One loader entry as a target, from the record the snapshot carried. */
function rowTarget(action: PluginManageAction, plugin: PluginInfo): PluginManageTarget {
  return {
    action,
    kind: 'row',
    entryId: plugin.entryId,
    moduleName: plugin.moduleName,
    patchId: 'patchId' in plugin ? plugin.patchId : undefined,
    enabled: plugin.enabled,
  }
}

/** The same bundle as gate 2 reads it: what the host says about control. */
function bundleGuardTarget(bundle: BundleInfo): PluginGuardTarget {
  return { kind: 'bundle', name: bundle.name, removable: bundle.removable, readOnlyReason: bundle.readOnlyReason }
}

/** The same loader entry as gate 2 reads it, given what the snapshot says about its row. */
function rowGuardTarget(plugin: PluginInfo, ownRowIds: ReadonlySet<string>): PluginGuardTarget {
  const patchId = 'patchId' in plugin ? plugin.patchId : undefined
  return {
    kind: 'row',
    entryId: plugin.entryId,
    moduleName: plugin.moduleName,
    patchId,
    ownRow: patchId !== undefined && ownRowIds.has(patchId),
    readOnlyReason: plugin.readOnlyReason,
  }
}

/** Rows inserted by either application layer; host and third-party rows remain addressable. */
function insertedRowIds(bundles: readonly BundleInfo[]): ReadonlySet<string> {
  return new Set(bundles.filter(bundle => COMPOSITION_PACKAGES.some(name => name === bundle.name))
    .flatMap(bundle => bundle.rows.map(row => row.rowId)))
}

/**
 * The row ids the host layer owns: the rows `dsh-base`'s patch inserts, plus the
 * built-in rows it overrides. Read off the same snapshot as everything else, so
 * no list of row ids lives here to drift from the profile that is actually
 * composed. An absent host layer answers the empty set, which asks nobody.
 */
function hostRowIdsOf(bundles: readonly BundleInfo[]): ReadonlySet<string> {
  const host = bundles.find(bundle => bundle.name === HOST_BUNDLE)
  if (host === undefined) return new Set<string>()
  return new Set([...host.rows.map(row => row.rowId), ...host.overrides])
}

/** What a person could have named instead: the identities the report prints. */
function addressableNames(bundles: readonly BundleInfo[], plugins: readonly PluginInfo[]): string {
  const names = [
    ...bundles.map(bundle => bundle.name),
    ...plugins.map(plugin => plugin.moduleName),
  ]
  return names.length === 0 ? '—' : [...new Set(names)].join(', ')
}

export function createPluginManageFlow(options: PluginManageFlowOptions): PluginManageFlow {
  const bindingAtStart = options.binding()
  /** The target, once resolved from the one snapshot the flow read. */
  let target: PluginManageTarget | undefined
  /** What the report calls it: its own name, never the argument text. */
  let label = ''

  /** Whether the session that asked is still bound; false drops every write. */
  const live = (): boolean => options.binding() === bindingAtStart
  const emit = (lines: readonly string[]): void => {
    if (lines.length === 0 || !live()) return
    options.onLines(lines)
  }
  /**
   * A turn is running: nothing is asked and no service is called. Checked at
   * both ends of the wait — before the resolution, and again before the write —
   * because a turn can start while the pane waits for an answer.
   */
  function refuseWhileBusy(): PluginManageStep | undefined {
    if (!options.busy()) return undefined
    emit([t('plugins-manage-busy')])
    return { kind: 'done' }
  }

  /**
   * Resolve the argument against one snapshot, run gate 2, and decide whether to
   * ask. A `done` step means the flow is over: something was reported.
   *
   * A bundle name is matched first and exactly. Only then the row identities, in
   * the order the host itself offers them: `entryId` (which is what
   * `setPluginEnabled` takes), then `patchId`, then the module name — the
   * weakest of the three, but the one a person can read straight off the report.
   */
  async function decide(): Promise<PluginManageStep> {
    let bundles: BundleInfo[]
    let plugins: PluginInfo[]
    try {
      bundles = await options.manager.listBundles()
      plugins = await options.manager.listPlugins()
    } catch (error) {
      emit([t('plugins-service-error', { err: cell(error instanceof Error ? error.message : String(error)) })])
      return { kind: 'done' }
    }
    const wanted = options.target
    const bundle = bundles.find(candidate => candidate.name === wanted)
    if (bundle !== undefined) {
      target = bundleTarget(options.action, bundle)
      label = cell(bundle.name)
      return await guardThenDecide(bundleGuardTarget(bundle), () => ask(hostRowIdsOf(bundles)))
    }
    let plugin = plugins.find(candidate => candidate.entryId === wanted)
      ?? plugins.find(candidate => 'patchId' in candidate && candidate.patchId === wanted)
    if (plugin === undefined) {
      const matches = plugins.filter(candidate => candidate.moduleName === wanted)
      if (matches.length > 1) {
        emit([t('plugins-manage-ambiguous', {
          target: cell(wanted),
          ids: cell(matches.map(candidate => candidate.entryId).join(', ')),
        })])
        return { kind: 'done' }
      }
      plugin = matches[0]
    }
    if (plugin !== undefined) {
      target = rowTarget(options.action, plugin)
      label = cell(plugin.moduleName)
      return await guardThenDecide(
        rowGuardTarget(plugin, insertedRowIds(bundles)),
        () => ask(hostRowIdsOf(bundles)),
      )
    }
    emit([t('plugins-manage-unknown', {
      target: cell(wanted),
      names: cell(addressableNames(bundles, plugins)),
    })])
    return { kind: 'done' }
  }

  /** Gate 2, then whatever the action decided to ask (or do) about an allowed target. */
  async function guardThenDecide(guardTarget: PluginGuardTarget, allowed: () => Promise<PluginManageStep>): Promise<PluginManageStep> {
    const verdict = pluginGuardVerdict(guardTarget, options.action)
    if (verdict.kind === 'refused') {
      // `service-locked` quotes the host's own word for it; a rule of ours gets
      // reported without one.
      emit([t(REFUSAL_KEYS[verdict.reason], { target: label, reason: cell(guardTarget.readOnlyReason ?? '') })])
      return { kind: 'done' }
    }
    return allowed()
  }

  /**
   * Gate 3's routing for the two actions that ask something (C-5).
   *
   * - **`enable`** always asks. `BundleInfo` carries no installation source:
   *   a local or Git package can claim the feed's exact name and version, so
   *   matching that metadata cannot prove it is a published artifact.
   * - **`remove`** asks about any bundle the guard allowed. The bundles the
   *   launcher supplies are `not-removable` and never reach here.
   * - **`disable`** asks only about a row the host layer owns — the one whose
   *   removal takes this application's own services down with it. A bundle and a
   *   third-party row are reversible and run no new code, so the guard's
   *   `allowed` is the whole answer — except the Agent Teams bundle while
   *   teammates are active, whose running turns lose their team tools.
   */
  async function ask(hostRowIds: ReadonlySet<string>): Promise<PluginManageStep> {
    const resolved = target
    if (resolved === undefined) return { kind: 'done' }
    if (options.action === 'remove') return { kind: 'confirm', target: resolved, question: { kind: 'remove' } }
    if (options.action === 'disable') {
      const hostRow = resolved.kind === 'row' && resolved.patchId !== undefined && hostRowIds.has(resolved.patchId)
      if (hostRow) return { kind: 'confirm', target: resolved, question: { kind: 'host-row' } }
      const { active, unseen } = resolved.kind === 'bundle' && resolved.name === TEAM_BUNDLE ? options.teamActiveMembers?.() ?? NO_TEAM_MEMBERS : NO_TEAM_MEMBERS
      return active + unseen > 0 ? { kind: 'confirm', target: resolved, question: { kind: 'team-active', members: active, unseen } } : run()
    }
    return { kind: 'confirm', target: resolved, question: { kind: 'trust' } }
  }

  /** Write through the service, then turn its result into the next step. */
  async function run(): Promise<PluginManageStep> {
    const current = target
    if (current === undefined) return { kind: 'done' }
    // The write is the point of no return, and a turn may have started while the
    // pane waited for an answer: re-check here, not only at `begin()`.
    const refused = refuseWhileBusy()
    if (refused !== undefined) return refused
    let residue: PluginResidueWatch | undefined
    if (current.kind === 'bundle' && current.action === 'remove') {
      try {
        // The declaration is inside the package that the write removes.
        residue = options.residueOf?.(current.name)
      } catch {
        // An unreadable declaration leaves the removal's residue unjudged.
      }
    }
    let result: ChangeResult
    try {
      result = await write(current)
    } catch (error) {
      // The service folds its failures in-band; only a lock or a disposal error
      // rejects, and that still has to leave a readable line behind.
      emit([t('plugins-manage-failed', { reason: cell(error instanceof Error ? error.message : String(error)) })])
      return { kind: 'done' }
    }
    // None of these three offers a cancellation; a service that reports one
    // anyway has already been reported by whatever stopped it.
    if (result.application === 'cancelled') return { kind: 'done' }
    if (result.application === 'failed') {
      const incompatible = result.error?.code === 'incompatible-version' ? result.error.incompatible ?? [] : []
      emit([
        t('plugins-manage-failed', { reason: failureReasonOf(result) }),
        ...incompatible.length === 0 ? [] : [t('plugins-manage-incompatible', {
          packages: incompatible.map(entry => `${cell(entry.name)}@${cell(entry.version)}`).join(', '),
          profile: cell(options.profileName ?? 'dsh-tui'),
        })],
        t(manualKeyOf(current.action), {
          profile: cell(options.profileName ?? 'dsh-tui'),
          target: label,
        }),
        t('plugins-install-rescue'),
      ])
      return { kind: 'done' }
    }
    // A disk no-op says nothing about higher-priority overrides or a pending
    // restart. Only an applied no-op is already in the requested state.
    if (!result.changed && result.application === 'applied') {
      emit([t('plugins-manage-unchanged', { target: label })])
      return { kind: 'done' }
    }
    const stateKey = result.application === 'restart-required'
      ? 'plugins-install-state-restart'
      : result.application === 'overridden' ? 'plugins-install-state-overridden' : 'plugins-install-state-applied'
    emit([
      t(APPLIED_KEYS[current.action], { target: label, state: t(stateKey) }),
      ...result.application === 'restart-required' ? [t('plugins-install-restart-hint')] : [],
    ])
    if (current.kind === 'bundle' && current.action === 'remove') reportResidue(current.name, residue)
    return { kind: 'done' }
  }

  /** The service call one action makes, with the id shape the service takes. */
  async function write(current: PluginManageTarget): Promise<ChangeResult> {
    if (current.action === 'remove' && current.kind === 'bundle') return options.manager.removeBundle(current.name)
    const enabled = current.action === 'enable'
    if (current.kind === 'bundle') return options.manager.setBundleEnabled(current.name, enabled)
    // A row is addressable whenever this is reached: gate 2 refused the rest.
    return options.manager.setPluginEnabled(current.entryId, enabled)
  }

  /**
   * What one removal left in this profile. The service rolls the profile's own
   * files back; everything under `~/.dsh-tui` — a backend's data directory, its
   * grants, its storage namespaces — is the person's own data and stays.
   * Reported once, deleted by nobody but them (decision D). Silent when the
   * watch judged the removal and found nothing: an "all clean" line on every
   * removal would be noise, and for a bundle that never had a backend it would
   * also answer a question nobody asked.
   */
  function reportResidue(name: string, watch: PluginResidueWatch | undefined): void {
    if (watch === undefined) {
      emit([t('plugins-manage-residue-unjudged', { target: cell(name) })])
      return
    }
    let left: readonly string[] | undefined
    try {
      left = watch()
    } catch {
      // The check reads the person's own files: a directory it cannot open is
      // "not judged", never "nothing left".
      emit([t('plugins-manage-residue-unjudged', { target: cell(name) })])
      return
    }
    if (left === undefined || left.length === 0) return
    emit([t('plugins-manage-residue', { paths: cell(left.join(', ')) })])
  }

  return {
    async begin() {
      const refused = refuseWhileBusy()
      if (refused !== undefined) return refused
      return decide()
    },
    async confirm() {
      return run()
    },
    dispose() {
      // Nothing subscribed today; see the interface's own note.
    },
  }
}

/**
 * The `/plugin remove|enable|disable` entry the screen calls: `/plugin`'s
 * argument text in, a flow out — or `undefined` for anything that is not one of
 * the three forms, and for a launch with no profile plugin service to act
 * through (the screen then runs the read-only report, which is where the CLI
 * route is printed).
 *
 * This is the one place that knows how a removal is wired to the running
 * composition, and the only place that touches the person's own data. The
 * residue watch is built here, **while the bundle is still installed**: the
 * declaration that names its data directory and its plugin identity is a file
 * inside the package, so it is unreadable once the bundle has left.
 */
export function createPluginManageEntry(
  ctx: Context,
  options: { readonly profileName?: string | undefined } = {},
): (args: string, sink: PluginManageSink) => PluginManageFlow | undefined {
  return (args, sink) => {
    const parsed = parsePluginArgs(args)
    if (parsed.kind !== 'remove' && parsed.kind !== 'enable' && parsed.kind !== 'disable') return undefined
    if (parsed.target === '') return undefined
    const manager = pluginManagerOf(ctx)
    if (manager === undefined) return undefined
    return createPluginManageFlow({
      manager,
      action: parsed.kind,
      target: parsed.target,
      binding: sink.binding,
      busy: sink.busy,
      onLines: sink.onLines,
      teamActiveMembers: sink.teamActiveMembers,
      profileName: options.profileName ?? resolveDshProfileName(),
      // Only a removal has anything to leave behind, and only a removal has a
      // package to read the declaration from.
      residueOf: parsed.kind === 'remove' ? name => residueWatchOf(ctx, name) : undefined,
    })
  }
}

/**
 * Watch one bundle's own data across its removal: the piece the flow cannot do
 * itself, because the declaration that names the identities lives *inside* the
 * package and is unreadable once the bundle has left the profile.
 *
 * The declaration says who the plugin is: its `id` is the identity the grants
 * file, the effect ledger and the storage namespaces record, and each
 * `x-dsh-tui` Backend contribution's `spec.id` names the `<dataDir>/backends/<id>`
 * directory that backend writes to (`src/utils/paths.ts`). Read now, checked
 * later.
 *
 * `undefined` when there is nothing to read: a bundle that ships no declaration
 * is not evidence of a clean removal, only of an unanswerable question.
 */
export function residueWatchOf(ctx: Context, name: string, dataRoot: string = DATA_DIR): PluginResidueWatch | undefined {
  const declaration = pluginDeclarationOf(ctx, name)
  if (declaration === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(declaration.source)
  } catch {
    return undefined
  }
  const record = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined
  const componentId = typeof record?.id === 'string' && record.id !== '' ? record.id : undefined
  const backendIds = backendIdsIn(record)
  if (componentId === undefined && backendIds.length === 0) return undefined
  return () => {
    const left: string[] = []
    for (const backendId of backendIds) {
      const dir = backendDataDir(backendId, dataRoot)
      if (existsSync(dir)) left.push(dir)
    }
    // The three footprint sources the grant matrix unions, asked through the
    // same reader that drew it — never by a second one that could disagree.
    if (componentId !== undefined && pluginFootprintContains(componentId, { dataDir: dataRoot })) {
      left.push(t('plugins-manage-residue-footprint', { id: cell(componentId) }))
    }
    return left
  }
}

/**
 * The backend ids a declaration contributes. Only a `Backend` entry names one,
 * and only through its validated `spec.id`. The outer `id` identifies the
 * contribution, not the backend whose data directory the host creates. Read
 * through the shared `declaredBackendsOf()` reader, so this watch and the D-1
 * assembly cannot disagree about which entries are backend contributions.
 */
function backendIdsIn(record: Record<string, unknown> | undefined): string[] {
  return [...new Set(declaredBackendsOf(record).backends.map(backend => backend.spec.id))]
}
