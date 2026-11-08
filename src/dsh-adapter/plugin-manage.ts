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
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { BundleInfo, ChangeResult, PluginEntryId, PluginInfo } from '@deepseek-ai/dsh-plugin-manager/types'
import { readGrantStore, type GrantStore } from '../adapter/standard/grants.js'
import { adapterRuntimeFor } from '../adapter/kernel/runtime-context.js'
import { t, type I18nKey } from '../i18n.js'
import { resolveDshProfileName } from '../update.js'
import { backendDataDir, DATA_DIR } from '../utils/paths.js'
import { applyGrantMutation, grantFailureText, grantsFilePath, planGrants, type GrantPlan, type GrantWriteOptions } from './grant-file.js'
import { COMPOSITION_PACKAGE, declaredBackendsOf, declaredGrantsOf, pluginDeclarationOf, type DeclaredGrants } from './plugin-declaration.js'
import { getHostGrantStore } from './host-grants.js'
import { failureReasonOf } from './plugin-install.js'
import {
  HOST_BUNDLE,
  type PluginGuardAction,
  pluginGuardVerdict,
  type PluginGuardRefusal,
  type PluginGuardTarget,
} from './plugin-guard.js'
import { pluginManagerOf, type PluginManagerView } from './plugin-manager.js'
import { cell, parsePluginArgs, pluginFootprintPaths, pluginFootprintSourcesOf } from './plugins-info.js'
import { storageFileName } from './plugin-storage.js'
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
  | {
    readonly kind: 'confirm'
    readonly target: PluginManageTarget
    readonly question: PluginManageQuestion
    /**
     * The bundle's declared permissions, when its declaration was readable
     * before the write: what an enable grants, what a disable revokes, and the
     * id a removal forgets. `undefined` for a row target and for a bundle with
     * no readable declaration.
     */
    readonly grants: GrantPlan | undefined
  }
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

/**
 * What one bundle's package-root declaration says, read **before** the write
 * (for a removal, while the package is still installed).
 *
 * `undefined` means the package ships no declaration, so nothing claims a
 * component id. `unreadable` means a declaration exists but this host cannot
 * read it: that is reported rather than guessed at, because guessing an id
 * would write a grant for some other package.
 */
export type PluginBundleDeclaration =
  | {
    readonly kind: 'declared'
    readonly grants: DeclaredGrants | undefined
    readonly residue: PluginResidueWatch | undefined
  }
  | { readonly kind: 'unreadable' }

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
   * The bundle's declaration, read while it is still installed: its grants
   * (what enable grants, disable revokes, removal forgets) and the residue
   * watch a removal consults after the write. One read, so the two answers
   * cannot come from different copies of the declaration.
   */
  readonly declarationOf?: ((name: string) => PluginBundleDeclaration | undefined) | undefined
  /** The live grant store: what is granted now and which names this host knows. */
  readonly grants?: GrantStore | undefined
  /** Test override for the grants file's directory. */
  readonly grantsDataDir?: string | undefined
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

/** The row ids one bundle's patch inserts. An absent bundle answers the empty set. */
function insertedRowIds(bundles: readonly BundleInfo[], name: string): ReadonlySet<string> {
  const bundle = bundles.find(candidate => candidate.name === name)
  return bundle === undefined ? new Set<string>() : new Set(bundle.rows.map(row => row.rowId))
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
  /** The bundle's declaration, captured while the package is still installed. */
  let declaration: PluginBundleDeclaration | undefined
  /** The plan for that declaration's permissions; `undefined` when unreadable. */
  let grantPlan: GrantPlan | undefined

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
      // Read once, before the write, for every bundle action: a removal can no
      // longer read the declaration afterwards, and enable/disable need the
      // same id and permissions.
      declaration = captureDeclaration(bundle.name)
      grantPlan = declaration?.kind === 'declared' && declaration.grants !== undefined && options.grants !== undefined
        ? planGrants(options.grants, declaration.grants)
        : undefined
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
        rowGuardTarget(plugin, insertedRowIds(bundles, COMPOSITION_PACKAGE)),
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
    const grants = resolved.kind === 'bundle' ? grantPlan : undefined
    if (options.action === 'remove') return { kind: 'confirm', target: resolved, question: { kind: 'remove' }, grants }
    if (options.action === 'disable') {
      const hostRow = resolved.kind === 'row' && resolved.patchId !== undefined && hostRowIds.has(resolved.patchId)
      if (hostRow) return { kind: 'confirm', target: resolved, question: { kind: 'host-row' }, grants }
      const { active, unseen } = resolved.kind === 'bundle' && resolved.name === TEAM_BUNDLE ? options.teamActiveMembers?.() ?? NO_TEAM_MEMBERS : NO_TEAM_MEMBERS
      return active + unseen > 0 ? { kind: 'confirm', target: resolved, question: { kind: 'team-active', members: active, unseen }, grants } : run()
    }
    return { kind: 'confirm', target: resolved, question: { kind: 'trust' }, grants }
  }

  /**
   * Read one bundle's declaration before the write. A resolver that throws is
   * treated exactly like an unreadable declaration: the action goes on, and
   * this flow reports that it cannot name the component rather than guessing
   * an id.
   */
  function captureDeclaration(name: string): PluginBundleDeclaration | undefined {
    try {
      return options.declarationOf?.(name)
    } catch {
      return { kind: 'unreadable' }
    }
  }

  /** The declared permission names a revoke acts on, de-duplicated, in order. */
  function declaredNames(declared: DeclaredGrants): string[] {
    return [...new Set(declared.permissions.map(permission => permission.name))]
  }

  /** What every grant write here hands the file layer. */
  function grantWriteOptions(): GrantWriteOptions {
    return {
      dataDir: options.grantsDataDir,
      knownPermissions: options.grants?.knownPermissions(),
    }
  }

  /** Grant a bundle's declared permissions before its code is loaded (enable). */
  async function ensureDeclared(plan: GrantPlan): Promise<{ changed: boolean; undo: () => Promise<boolean> } | undefined> {
    if (options.grants === undefined) return undefined
    const write = await applyGrantMutation({ kind: 'ensure', id: plan.id, permissions: plan.entries }, grantWriteOptions())
    if (!write.ok) {
      emit([t('plugins-grant-write-refused', {
        file: cell(grantsFilePath(options.grantsDataDir)),
        reason: grantFailureText(write),
      })])
      return undefined
    }
    if (plan.unknown.length > 0) {
      emit([t('plugins-grant-unknown-skipped', { names: cell(plan.unknown.join(', ')) })])
    }
    if (write.changed) {
      emit([t('plugins-manage-grant-granted', {
        count: String(plan.entries.length),
        id: cell(plan.id),
      })])
    }
    const store = options.grants
    if (store !== undefined) {
      const unapplied = plan.entries.filter(entry => !store.allows({ componentId: plan.id }, entry.name, entry.scope))
      if (unapplied.length > 0) {
        emit([t('plugins-grant-unapplied', {
          scopes: cell(unapplied.map(entry => `${entry.name}@${entry.scope}`).join(', ')),
        })])
      }
    }
    return write
  }

  /** Revoke the declared permission names after the code is unloaded (disable). */
  async function revokeDeclared(declared: DeclaredGrants): Promise<void> {
    if (options.grants === undefined) return
    const names = declaredNames(declared)
    if (names.length === 0) return
    const write = await applyGrantMutation({ kind: 'revoke', id: declared.id, names }, grantWriteOptions())
    if (!write.ok) {
      emit([t('plugins-manage-grant-revoke-failed', {
        reason: grantFailureText(write),
        id: cell(declared.id),
        file: cell(grantsFilePath(options.grantsDataDir)),
      })])
      return
    }
    if (write.changed) {
      emit([t('plugins-manage-grant-revoked', { count: String(names.length), id: cell(declared.id) })])
    }
  }

  /** Delete the component's grant entries after its package left (remove). */
  async function forgetDeclared(declared: DeclaredGrants): Promise<void> {
    if (options.grants === undefined) return
    const write = await applyGrantMutation({ kind: 'forget', id: declared.id }, grantWriteOptions())
    if (!write.ok) {
      // The one path that leaves an inheritance risk behind: a package reusing
      // this component id would inherit these rules. Say so, with the id and
      // the file, instead of a quiet warning.
      emit([t('plugins-manage-grant-forget-failed', {
        reason: grantFailureText(write),
        id: cell(declared.id),
        file: cell(grantsFilePath(options.grantsDataDir)),
      })])
      return
    }
    if (write.changed) emit([t('plugins-manage-grant-forgotten', { id: cell(declared.id) })])
  }

  /** An enable whose write failed: put the grant back, or say why not. */
  async function rollbackGrant(write: { readonly changed: boolean; readonly undo: () => Promise<boolean> } | undefined): Promise<void> {
    if (write === undefined || !write.changed) return
    const restored = await write.undo()
    emit([t(restored ? 'plugins-grant-rolled-back' : 'plugins-grant-rollback-failed')])
  }

  /** Write through the service, then turn its result into the next step. */
  async function run(): Promise<PluginManageStep> {
    const current = target
    if (current === undefined) return { kind: 'done' }
    // The write is the point of no return, and a turn may have started while the
    // pane waited for an answer: re-check here, not only at `begin()`.
    const refused = refuseWhileBusy()
    if (refused !== undefined) return refused
    // The declaration was captured in `decide()`, before the write: a removal
    // can no longer read the package afterwards. A declaration that exists but
    // cannot be read is reported here, with no id guessed.
    if (current.kind === 'bundle' && declaration !== undefined
      && (declaration.kind === 'unreadable' || declaration.grants === undefined)) {
      emit([t('plugins-manage-grant-unhandled', { target: label })])
    }
    const declared = current.kind === 'bundle' && declaration?.kind === 'declared' ? declaration.grants : undefined
    const plan = current.kind === 'bundle' ? grantPlan : undefined
    // Grant before the write that loads the code; revoke and forget after the
    // write that unloads it (grant lifecycle plan §6.2). A failed enable puts
    // the grant back; the other two act only on a successful write.
    const grantWrite = current.action === 'enable' && plan !== undefined ? await ensureDeclared(plan) : undefined
    let result: ChangeResult
    try {
      result = await write(current)
    } catch (error) {
      // The service folds its failures in-band; only a lock or a disposal error
      // rejects, and that still has to leave a readable line behind.
      emit([t('plugins-manage-failed', { reason: cell(error instanceof Error ? error.message : String(error)) })])
      if (current.action === 'enable') await rollbackGrant(grantWrite)
      return { kind: 'done' }
    }
    // None of these three offers a cancellation; a service that reports one
    // anyway has already been reported by whatever stopped it.
    if (result.application === 'cancelled') {
      if (current.action === 'enable') await rollbackGrant(grantWrite)
      return { kind: 'done' }
    }
    if (result.application === 'failed') {
      // The profile's own files decide whether the enable landed: a reload
      // failure after the selection was saved keeps the grant (the next start
      // enables the bundle with its declaration), while a failed save puts it
      // back. `application` alone cannot tell the two apart.
      if (current.action === 'enable' && !result.changed) await rollbackGrant(grantWrite)
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
      if (current.action === 'enable' && result.changed) emit([t('plugins-manage-enable-persisted')])
      return { kind: 'done' }
    }
    // The write landed (or the profile was already in that state): a disable is
    // still "off and revoked", and a removal still forgets the component. The
    // declaration was read before the write, which is the only moment it could
    // be read.
    if (declared !== undefined) {
      if (current.action === 'remove') await forgetDeclared(declared)
      else if (current.action === 'disable') await revokeDeclared(declared)
    }
    // A disk no-op says nothing about higher-priority overrides or a pending
    // restart. Only an applied no-op is already in the requested state.
    if (!result.changed && result.application === 'applied') {
      emit([t('plugins-manage-unchanged', { target: label })])
      if (current.kind === 'bundle' && current.action === 'remove') reportResidue(current.name, declaration)
      return { kind: 'done' }
    }
    const stateKey = result.application === 'restart-required'
      ? 'plugins-install-state-restart'
      : result.application === 'overridden' ? 'plugins-install-state-overridden' : 'plugins-install-state-applied'
    emit([
      t(APPLIED_KEYS[current.action], { target: label, state: t(stateKey) }),
      ...result.application === 'restart-required' ? [t('plugins-install-restart-hint')] : [],
    ])
    if (current.kind === 'bundle' && current.action === 'remove') reportResidue(current.name, declaration)
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
   * files back; everything under `~/.dsh-tui` — a backend's data directory, the
   * effect ledger, storage namespaces — is the person's own data and stays.
   * The component's **grant entries** are the one exception: they are deleted
   * with the component, because a later package reusing its id would inherit
   * them (grant lifecycle plan D-3). Reported by source (D-5), once. Silent
   * when the declaration was read and nothing is left.
   */
  function reportResidue(name: string, declaration: PluginBundleDeclaration | undefined): void {
    if (declaration === undefined || declaration.kind === 'unreadable') {
      emit([t('plugins-manage-residue-unjudged', { target: cell(name) })])
      return
    }
    const watch = declaration.residue
    if (watch === undefined) {
      // The declaration named no identity this check could look for. The old
      // residue watch answered the same way: not judged, never "clean".
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
 * This is the one place that knows how a lifecycle action is wired to the
 * running composition, and the only place that touches the person's own data.
 * The bundle's declaration is read here, **while it is still installed**: its
 * grants and the residue watch both come from a file inside the package, so
 * both are unreadable once the bundle has left.
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
    // The same live store the /plugin report and the plugin-host row use.
    const grants = getHostGrantStore(ctx.get('tuiPluginHost'))
      ?? readGrantStore(undefined, undefined, adapterRuntimeFor(ctx))
    return createPluginManageFlow({
      manager,
      action: parsed.kind,
      target: parsed.target,
      binding: sink.binding,
      busy: sink.busy,
      onLines: sink.onLines,
      teamActiveMembers: sink.teamActiveMembers,
      profileName: options.profileName ?? resolveDshProfileName(),
      grants,
      declarationOf: name => bundleDeclarationOf(ctx, name),
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
  const declaration = bundleDeclarationOf(ctx, name, dataRoot)
  return declaration?.kind === 'declared' ? declaration.residue : undefined
}

/**
 * Read one installed bundle's declaration once, before any lifecycle write.
 *
 * The declaration is the package's own file, so it has to be read while the
 * package is still there: after a removal it is gone, and after an enable or
 * disable the grants half still has to name the component id. The raw parse
 * feeds both answers — the residue watch (which trusts the declaration's own
 * `id`/Backend ids, as before) and the grants reader (which applies the same
 * parse/projection gates every other consumer does). A file that exists but
 * cannot be read is `unreadable`, never "no declaration": the two lead to
 * different reports.
 */
export function bundleDeclarationOf(
  ctx: Context,
  name: string,
  dataRoot: string = DATA_DIR,
): PluginBundleDeclaration | undefined {
  const declaration = pluginDeclarationOf(ctx, name)
  if (declaration === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(declaration.source)
  } catch {
    return { kind: 'unreadable' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unreadable' }
  const record = parsed as Record<string, unknown>
  const componentId = typeof record.id === 'string' && record.id !== '' ? record.id : undefined
  const backendIds = backendIdsIn(record)
  const grants = declaredGrantsOf(record)
  const residue: PluginResidueWatch | undefined = componentId === undefined && backendIds.length === 0
    ? undefined
    : () => {
      const left: string[] = []
      for (const backendId of backendIds) {
        const dir = backendDataDir(backendId, dataRoot)
        if (existsSync(dir)) left.push(dir)
      }
      if (componentId !== undefined) {
        // One source per line (D-5): the grants entry was deleted with the
        // component, so what remains here is the audit ledger and the person's
        // storage namespace, each named by its own path.
        const sources = pluginFootprintSourcesOf(componentId, { dataDir: dataRoot })
        const paths = pluginFootprintPaths({ dataDir: dataRoot })
        const id = cell(componentId)
        if (sources.ledger) left.push(t('plugins-manage-residue-ledger', { id, file: cell(paths.ledgerFile) }))
        if (sources.storage) {
          left.push(t('plugins-manage-residue-storage', {
            id,
            file: cell(join(paths.storageDir, `${storageFileName(componentId)}.json`)),
          }))
        }
      }
      return left
    }
  return { kind: 'declared', grants, residue }
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
