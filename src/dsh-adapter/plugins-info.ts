/**
 * /plugin diagnostics surface (C-070 trust disclosure + C-030 negotiation
 * diagnostics): assembles the lines behind the `/plugin` command.
 *
 * Sections (overview):
 *
 * 1. TRUST BANNER — always the first line (C-070): plugins run in-process;
 *    grants are behavioral constraints, not a security boundary; passing
 *    validation is not proof of safety.
 * 2. HOST DESCRIPTOR summary — what the running host actually advertises
 *    (coordinates + generation), including drift-dropped contracts.
 * 3. GRANT MATRIX — plugins × the registered permissions. The plugin set is
 *    the union of FOOTPRINTS ONLY: keys of the grants file, pluginIds seen
 *    in the effect ledger, and storage namespaces on disk. The header says so
 *    honestly. (The profile's own bundles and rows are a different question
 *    and come from the host plugin service, below — this matrix stays the
 *    footprint view it has always been.)
 * 4. LEDGER TAIL — the last 5 effect-ledger records.
 * 5. BUNDLES AND ROWS — what the profile composes, from `ctx.pluginManager`
 *    (`./plugin-manager.ts`): official installation-supplied bundles first,
 *    then the profile's own, each with gate 1's tag from its declaration
 *    (`./plugin-declaration.ts`), plus the loader entries no patch row can
 *    address. Absent service → every line above is unchanged and one line
 *    says why the half is missing.
 *
 * `/plugin check <path>` uses the parser and projection from the pinned
 * @dsh-std/manifest revision, then evaluates every public/private protocol
 * through one ProtocolCatalog. Manifests and on-disk files are UNTRUSTED input:
 * every derived line passes cleanScalarText before it reaches the
 * transcript, and any credential they quote — a URL field, the spec a person
 * typed, text the service hands back — is redacted first (`redactUrl`/
 * `redactText`).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { BundleInfo, PluginInfo, PluginRegistries, PluginSpecInspection } from '@deepseek-ai/dsh-plugin-manager/types'
import { parseManifest, projectManifest } from '../adapter/standard/protocols.js'
import { DATA_DIR } from '../utils/paths.js'
import { t, type I18nKey } from '../i18n.js'
import { loadSpecData } from '../adapter/standard/registry.js'
import { createContractIndex, validatePlugin, negotiate } from '../adapter/standard/admission.js'
import type { NegotiationDecision } from '../adapter/standard/types.js'
import { cleanScalarText } from './sanitize.js'
import type { GrantStore } from '../adapter/standard/grants.js'
import type { HostDescriptorBuild } from '../adapter/standard/descriptor.js'
import { isCompositionOwned, pluginDeclarationIn, type PluginDeclaration, type PluginInstallNotice } from './plugin-declaration.js'
import { TUI_EXPERIMENTAL_BUNDLES } from './experimental-bundles.js'
import { extraBundles, localizedPluginText, type PluginManagerView } from './plugin-manager.js'
import { PLUGIN_STORAGE_DIR } from './plugin-storage.js'
import { EFFECT_LEDGER_NAME } from './effect-ledger.js'

/** How many plugins the matrix shows before an overflow note. */
export const PLUGINS_MATRIX_MAX_ROWS = 20
/** How many ledger records the tail section shows. */
export const PLUGINS_LEDGER_TAIL = 5
/** Per-line cell cap for file-derived content. */
const LINE_CELLS = 200

export interface PluginsInfoDeps {
  /** Effective grant answers (the plugin-host row's store when mounted). */
  grants: GrantStore
  /** The plugin-host row's descriptor build; undefined → row not mounted. */
  host?: HostDescriptorBuild
  /** A package's declaration, resolved from the running composition. */
  declaration?: (packageName: string) => PluginDeclaration | undefined
  /** Test overrides; default under DATA_DIR. */
  dataDir?: string
  ledgerFile?: string
  storageDir?: string
}

interface LedgerLine {
  sequence?: unknown
  operation?: unknown
  pluginId?: unknown
  resource?: { kind?: unknown; id?: unknown }
  result?: unknown
  errorCode?: unknown
}

/** Query parameters that are a secret on their own: a credential needs no
 *  userinfo (`https://registry.example.com/?token=…`). */
const CREDENTIAL_QUERY_KEY = /^(?:token|access_token|auth|authorization|password|passwd|pwd|_auth|_authtoken|apikey|api_key|key|secret)$/i

/**
 * A URL with any credentials removed: npm and pnpm accept
 * `https://user:token@registry/…` and `?token=…`, and this report is a
 * transcript — neither may reach the screen or its scrollback. Host and path
 * stay readable, so the person still recognizes which registry answered. A
 * value that is not a URL at all (pnpm accepts odd ones) passes through
 * unchanged.
 */
function redactUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return value
  }
  // Userinfo goes with the whole query: a URL that authenticates there often
  // pairs it with a token in the query.
  if (url.password !== '' || url.username !== '') return `${url.origin}${url.pathname}`
  let dropped = false
  for (const key of [...url.searchParams.keys()]) {
    if (CREDENTIAL_QUERY_KEY.test(key)) {
      url.searchParams.delete(key)
      dropped = true
    }
  }
  return dropped ? `${url.origin}${url.pathname}${url.search}` : value
}

/** A URL-shaped run inside free text: the spec a person typed, and the same
 *  URL quoted back in a refusal reason or a thrown error. */
const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s]+/giu
/** What the parser refuses — a styled (ANSI) URL, an odd host — still loses its
 *  userinfo, so the one value it cannot read is not the gap a secret leaves by. */
const USERINFO_AT_START = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]*@/iu

/**
 * Free text with every URL it quotes redacted. The three paths that print text
 * rather than a URL field — an accepted spec the upstream left unnamed, a
 * refusal reason, an exception message — all funnel through here.
 */
function redactText(value: string): string {
  if (!value.includes('://')) return value
  return value.replace(URL_IN_TEXT, match => {
    const redacted = redactUrl(match)
    return redacted === match ? match.replace(USERINFO_AT_START, '$1') : redacted
  })
}

/**
 * One report cell: credentials redacted first, then sanitized, then capped —
 * truncation comes last, or a cut URL keeps the head of its own secret.
 *
 * Exported for the install flow (C-4): pnpm's output and the service's error
 * text are foreign input reaching the same transcript, and one renderer means
 * the two surfaces cannot disagree about what a cell is.
 */
export const cell = (value: unknown): string => cleanScalarText(redactText(String(value ?? '')), LINE_CELLS)

/** One URL field as a report cell: credentials stripped, then capped. */
const urlCell = (value: string): string => cell(redactUrl(value))

/** Parse the ledger file tolerantly (skip corrupt lines, never throw). */
function readLedgerRecords(file: string): LedgerLine[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const records: LedgerLine[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object') records.push(parsed as LedgerLine)
    } catch {
      // Corrupt line: the diagnostics surface skips it (never rewrites).
    }
  }
  return records
}

/** Where the three footprint sources live. */
export interface PluginFootprintPaths {
  readonly dataDir: string
  readonly ledgerFile: string
  readonly storageDir: string
}

/** Test overrides for {@link pluginFootprintPaths}; the report's own deps satisfy it. */
export interface PluginFootprintOverrides {
  readonly dataDir?: string | undefined
  readonly ledgerFile?: string | undefined
  readonly storageDir?: string | undefined
}

/** The plugin set for the matrix: grants-file keys ∪ ledger pluginIds ∪
 *  storage namespaces ('host'/'undeclared' ledger identities are not
 *  plugins and are excluded). */
export function pluginFootprints(paths: PluginFootprintPaths): string[] {
  const found = new Set<string>()
  try {
    const raw: unknown = JSON.parse(readFileSync(join(paths.dataDir, 'extension-grants.json'), 'utf8'))
    if (raw !== null && typeof raw === 'object') {
      const table = raw as { grants?: unknown; denies?: unknown }
      for (const section of [table.grants, table.denies]) {
        if (section !== null && typeof section === 'object') {
          for (const plugin of Object.keys(section)) found.add(plugin)
        }
      }
    }
  } catch {
    // Missing/corrupt grants file: the GrantStore already answers deny;
    // the matrix simply has no rows from this source.
  }
  for (const record of readLedgerRecords(paths.ledgerFile)) {
    if (typeof record.pluginId === 'string' && record.pluginId !== '' && record.pluginId !== 'host' && record.pluginId !== 'undeclared') {
      found.add(record.pluginId)
    }
  }
  try {
    for (const entry of readdirSync(paths.storageDir)) {
      if (!entry.endsWith('.json')) continue
      const namespace = decodeURIComponent(entry.slice(0, -'.json'.length))
      if (namespace !== '') found.add(namespace)
    }
  } catch {
    // No storage directory yet: no rows from this source.
  }
  return [...found].sort()
}

/**
 * The three footprint sources, resolved the way the diagnostics resolve them
 * (test overrides first, else the packaged locations under `~/.dsh-tui`).
 */
export function pluginFootprintPaths(overrides: PluginFootprintOverrides = {}): PluginFootprintPaths {
  const dataDir = overrides.dataDir ?? DATA_DIR
  return {
    dataDir,
    ledgerFile: overrides.ledgerFile ?? join(dataDir, EFFECT_LEDGER_NAME),
    storageDir: overrides.storageDir ?? join(dataDir, PLUGIN_STORAGE_DIR),
  }
}

/**
 * Whether one plugin id still has a footprint in this profile: a grants-file
 * key, an effect-ledger record, or a storage namespace. The same three sources
 * the matrix unions — a removal that left something behind is read here rather
 * than by a second reader that could disagree with the report (C-5).
 */
export function pluginFootprintContains(pluginId: string, overrides: PluginFootprintOverrides = {}): boolean {
  return pluginFootprints(pluginFootprintPaths(overrides)).includes(pluginId)
}

/** `/plugin check <path>`: official parse/projection + profile validation + negotiation. */
function checkManifestLines(pathArg: string, deps: PluginsInfoDeps): string[] {
  const lines: string[] = []
  const target = resolve(pathArg)
  if (!existsSync(target)) {
    lines.push(t('plugins-check-not-found', { path: cell(pathArg) }))
    return lines
  }
  let source: string
  try {
    source = readFileSync(target, 'utf8')
  } catch (error) {
    lines.push(t('plugins-check-invalid-json', { err: cell(error instanceof Error ? error.message : String(error)) }))
    return lines
  }
  const data = loadSpecData()
  if (data === undefined) {
    lines.push(t('plugins-check-spec-unavailable'))
    return lines
  }
  let manifest
  try {
    manifest = parseManifest(source, { source: target })
    // Projection is an explicit admission stage. validatePlugin performs its
    // own defensive projection too, but keeping this call here makes parser
    // and projection failures distinguishable at the user-facing boundary.
    projectManifest(manifest)
  } catch (error) {
    const message = cell(error instanceof Error ? error.message : String(error))
    lines.push(error instanceof SyntaxError
      ? t('plugins-check-invalid-json', { err: message })
      : t('plugins-check-schema-failed', { err: message }))
    return lines
  }
  const index = createContractIndex(data.registry, data.permissions)
  try {
    validatePlugin(index, manifest)
  } catch (error) {
    lines.push(t('plugins-check-invalid', { err: cell(error instanceof Error ? error.message : String(error)) }))
    return lines
  }
  // No live host: do NOT fall back to a full advertised surface. The check
  // stays static (validation only) and explicitly reports host-unavailable /
  // non-live instead of participating in protocol support negotiation.
  const host = deps.host
  if (host === undefined) {
    lines.push(t('plugins-check-host-unavailable'))
    return lines
  }
  const granted = manifest.permissions
    .map(request => ({
      name: request.name,
      scope: request.scope,
      // `/plugin check` has no live activation instance. Passing an
      // activation-less principal makes GrantStore fail closed when policy
      // contains activation-scoped rules instead of treating them as global.
      granted: deps.grants.allows({ componentId: manifest.id }, request.name, request.scope),
    }))
  const decision = negotiate(index, manifest, host.descriptor, granted)
  lines.push(...decisionLines(decision))
  if (decision.decision === 'waiting_authorization') {
    // Close the loop on the five-state vocabulary: the user sees not just
    // the state but the exact file + shape that flips it (the interactive
    // grant flow is future work; this hint is its no-UI prerequisite).
    lines.push(t('plugins-check-grant-hint', {
      id: cell(manifest.id),
      perms: cell(decision.deniedPermissions.join(', ')),
    }))
  }
  if (host.dropped.length > 0) {
    lines.push(t('plugins-check-dropped', { dropped: cell(host.dropped.join(', ')) }))
  }
  return lines
}

/** The five-state vocabulary as one cell (shared by `check` and the list tags). */
function stateText(decision: NegotiationDecision): string {
  switch (decision.decision) {
    case 'compatible':
      return 'compatible'
    case 'compatible_degraded':
      return `compatible_degraded (missingOptional: ${cell(decision.missingOptional.join(', '))})`
    case 'waiting_authorization':
      return `waiting_authorization (${cell(decision.reasonCode)}: ${cell(decision.deniedPermissions.join(', '))})`
    case 'rejected': {
      const detail = decision.missingRequired !== undefined
        ? `${cell(decision.reasonCode)}: ${cell(decision.missingRequired.join(', '))}`
        : `${cell(decision.reasonCode)}: facet ${cell(decision.facetApiVersion)} vs host [${cell((decision.hostFacetApiVersions ?? []).join(', '))}]`
      return `rejected (${detail})`
    }
    case 'unknown':
      return `unknown (${cell(decision.reasonCode)}: ${cell(decision.unknownContracts.join(', '))})`
  }
}

function decisionLines(decision: NegotiationDecision): string[] {
  return [t('plugins-check-state', { state: stateText(decision) })]
}

/** Which form of the command the raw argument text asks for. */
export type PluginArgs =
  | { readonly kind: 'overview' }
  | { readonly kind: 'list' }
  | { readonly kind: 'check'; readonly path: string }
  | { readonly kind: 'info'; readonly spec: string }
  | { readonly kind: 'registries' }
  /** `/plugin install <spec>`: the write path (C-4), which the UI drives. */
  | { readonly kind: 'install'; readonly spec: string }
  /**
   * The three lifecycle forms (C-5), which the UI drives through
   * `dsh-adapter/plugin-manage.ts`. `target` is the raw argument: a bundle name
   * or a row identity, resolved by the flow against the profile it reads rather
   * than by a grammar here.
   */
  | { readonly kind: 'remove'; readonly target: string }
  | { readonly kind: 'enable'; readonly target: string }
  | { readonly kind: 'disable'; readonly target: string }
  | { readonly kind: 'unknown'; readonly sub: string }

/** Route `/plugin`'s argument text: one parser, so both halves of the report agree. */
export function parsePluginArgs(args: string): PluginArgs {
  const trimmed = args.trim()
  if (trimmed === '') return { kind: 'overview' }
  const [sub, ...rest] = trimmed.split(/\s+/)
  if (sub === 'list') return { kind: 'list' }
  if (sub === 'check') return { kind: 'check', path: rest.join(' ') }
  if (sub === 'info') return { kind: 'info', spec: rest.join(' ') }
  if (sub === 'registries') return { kind: 'registries' }
  if (sub === 'install') return { kind: 'install', spec: rest.join(' ') }
  if (sub === 'remove') return { kind: 'remove', target: rest.join(' ') }
  if (sub === 'enable') return { kind: 'enable', target: rest.join(' ') }
  if (sub === 'disable') return { kind: 'disable', target: rest.join(' ') }
  return { kind: 'unknown', sub: sub ?? '' }
}

/** The `/plugin` overview lines (banner always first). */
export function pluginsInfoLines(args: string, deps: PluginsInfoDeps): string[] {
  const lines: string[] = [t('plugins-trust-banner')]
  const parsed = parsePluginArgs(args)
  if (parsed.kind === 'check') {
    if (parsed.path === '') {
      lines.push(t('plugins-check-usage'))
      return lines
    }
    lines.push(...checkManifestLines(parsed.path, deps))
    return lines
  }
  if (parsed.kind === 'unknown') {
    lines.push(t('plugins-unknown-subcommand', { sub: cell(parsed.sub) }))
    return lines
  }
  // `list` is the short form: the trust banner and what the profile added, no
  // diagnostics. Its data comes from the service half below.
  if (parsed.kind === 'list') return lines
  // `info <spec>` names what it is looking for, so a bare one is a usage error
  // the sync half can already answer; both service forms render below.
  if (parsed.kind === 'info') {
    if (parsed.spec === '') lines.push(t('plugins-info-usage'))
    return lines
  }
  if (parsed.kind === 'registries') return lines
  // `install <spec>` is the write path (C-4): a bare one is a usage error, and
  // the UI drives the rest — this half stays the diagnostics it always was.
  if (parsed.kind === 'install') {
    if (parsed.spec === '') lines.push(t('plugins-install-usage'))
    return lines
  }
  // The three lifecycle forms (C-5) report themselves as they run, like an
  // install: a bare one is a usage error, and this half stays the diagnostics.
  if (parsed.kind === 'remove' || parsed.kind === 'enable' || parsed.kind === 'disable') {
    if (parsed.target === '') lines.push(t('plugins-manage-usage', { sub: parsed.kind }))
    return lines
  }

  // ── Host Descriptor ──
  if (deps.host === undefined) {
    lines.push(t('plugins-host-unavailable'))
  } else {
    const { descriptor, dropped } = deps.host
    lines.push(`Host Descriptor: ${cell(descriptor.hostId)} v${cell(descriptor.hostVersion)} · generation ${cell(descriptor.runtime.generationId)}`)
    lines.push(`  facets: ${cell(descriptor.facetApiVersions.join(', ') || '—')}`)
    for (const contract of descriptor.contracts) {
      const definition = contract.definition.source === 'dsh-std'
        ? contract.definition.package
        : contract.definition.profileHash.slice(0, 19) + '…'
      lines.push(`  ${cell(contract.apiVersion)}#${cell(contract.kind)} · definition ${cell(definition)} · perms ${cell(contract.permissions.join(', ') || '—')}`)
    }
    for (const coordinate of dropped) {
      lines.push(`  ${cell(coordinate)} · ${t('plugins-contract-dropped')}`)
    }
  }

  // ── 授权矩阵 ──
  const plugins = pluginFootprints(pluginFootprintPaths(deps))
  lines.push(t('plugins-matrix-note'))
  const permissions = deps.grants.knownPermissions()
  if (permissions.length === 0) {
    lines.push(`  ${t('plugins-matrix-no-registry')}`)
  } else if (plugins.length === 0) {
    lines.push(`  ${t('plugins-matrix-empty')}`)
  } else {
    lines.push(`  ${permissions.map((permission, index) => `[${index + 1}] ${cell(permission)}`).join('  ')}`)
    const shown = plugins.slice(0, PLUGINS_MATRIX_MAX_ROWS)
    const width = Math.max(...shown.map(plugin => plugin.length), 8)
    for (const plugin of shown) {
      const diagnosticScope = (permission: string): string => {
        if (permission === 'storage.local.read' || permission === 'storage.local.write') return plugin
        if (permission === 'commands.invoke') return 'diagnostic.command'
        return 'session:*'
      }
      const marks = permissions.map(permission => (
        deps.grants.allows({ componentId: plugin }, permission, diagnosticScope(permission)) ? '✓' : '·'
      )).join(' ')
      lines.push(`  ${cell(plugin).padEnd(width)}  ${marks}`)
    }
    if (plugins.length > shown.length) {
      lines.push(`  ${t('plugins-footprint-overflow', { count: plugins.length - shown.length })}`)
    }
    // Actionable next step for the · marks (same loop-closer as the check
    // path): the file path + rule shape, so granting needs no spec reading.
    lines.push(`  ${t('plugins-grant-hint')}`)
  }

  // ── 台账尾 ──
  const ledgerFile = pluginFootprintPaths(deps).ledgerFile
  const records = readLedgerRecords(ledgerFile)
  if (records.length === 0) {
    lines.push(t('plugins-ledger-empty'))
  } else {
    lines.push(t('plugins-ledger-header', { file: cell(ledgerFile) }))
    for (const record of records.slice(-PLUGINS_LEDGER_TAIL)) {
      const resource = record.resource ?? {}
      lines.push(
        `  #${cell(record.sequence)} ${cell(record.operation)} ${cell(resource.kind)}/${cell(resource.id)} ` +
        `${cell(record.pluginId)} ${cell(record.result)}${typeof record.errorCode === 'string' ? ` (${cell(record.errorCode)})` : ''}`,
      )
    }
  }
  return lines
}

/**
 * What a listed package says about itself (gate 1's evidence): no declaration
 * at all, a declaration this profile cannot read, or the negotiated decision.
 */
type DeclarationVerdict =
  | { readonly kind: 'undeclared' }
  | { readonly kind: 'invalid'; readonly error: string }
  | { readonly kind: 'decided'; readonly decision: NegotiationDecision }

/**
 * A declaration this profile can use: parsed, projected and validated against
 * the admission catalog — the half `check <path>` and the list tags share. One
 * implementation, so every surface that judges a declaration is judging the
 * same thing; the caller decides what to do with the answer (the tag negotiates
 * it further, the pre-install notice does not).
 */
function admitDeclaration(declaration: PluginDeclaration):
  | { readonly error: string }
  | { readonly manifest: ReturnType<typeof parseManifest>; readonly index: ReturnType<typeof createContractIndex> } {
  const data = loadSpecData()
  if (data === undefined) return { error: t('plugins-check-spec-unavailable') }
  let manifest: ReturnType<typeof parseManifest>
  try {
    manifest = parseManifest(declaration.source, { source: declaration.path })
    projectManifest(manifest)
  } catch (error) {
    return { error: cell(error instanceof Error ? error.message : String(error)) }
  }
  const index = createContractIndex(data.registry, data.permissions)
  try {
    validatePlugin(index, manifest)
  } catch (error) {
    return { error: cell(error instanceof Error ? error.message : String(error)) }
  }
  return { manifest, index }
}

/** Evaluate one declaration exactly as `check <path>` does. */
function verdictOfDeclaration(deps: PluginsInfoDeps, declaration: PluginDeclaration): DeclarationVerdict {
  const admitted = admitDeclaration(declaration)
  if ('error' in admitted) return { kind: 'invalid', error: admitted.error }
  const host = deps.host
  if (host === undefined) return { kind: 'invalid', error: t('plugins-check-host-unavailable') }
  const granted = admitted.manifest.permissions.map(request => ({
    name: request.name,
    scope: request.scope,
    granted: deps.grants.allows({ componentId: admitted.manifest.id }, request.name, request.scope),
  }))
  return { kind: 'decided', decision: negotiate(admitted.index, admitted.manifest, host.descriptor, granted) }
}

/** Evaluate a package's declaration exactly as `check <path>` does. */
function declarationVerdict(deps: PluginsInfoDeps, packageName: string): DeclarationVerdict {
  const declaration = deps.declaration?.(packageName)
  if (declaration === undefined) return { kind: 'undeclared' }
  return verdictOfDeclaration(deps, declaration)
}

/**
 * Gate 1's pre-install statement about an install target (C-4), as data.
 *
 * It runs the same parse/project/validate pipeline `check <path>` and the list
 * tags run — one implementation, so the surfaces cannot disagree — over the
 * declaration of the target directory the caller resolved. It deliberately stops
 * before `negotiate`: admission's five states are a statement about a *running*
 * host, and the standing tag in `/plugin` is where they are reported after the
 * install. What a person needs before installing is narrower and decidable: is
 * there a declaration at all, and does this profile's catalog accept it.
 *
 * The evidence is the target directory and nothing else. A declaration resolved
 * by package name would be the profile's already-installed copy of that name —
 * a different artifact from the one being installed (another version, or a local
 * directory), which is how a stale same-name package used to answer for a new
 * target.
 *
 * The two empty answers are not the same thing, and that is the point:
 *
 * - a directory the caller resolved (`install <path>` specs) either carries a
 *   package-root `dsh-plugin.json` or does not, so no file is `undeclared`;
 * - a target with no directory to read (a registry name, a tarball, a git spec)
 *   ships no file this machine can read, so an empty answer there is `unjudged`
 *   — the flow cannot honestly claim a package it has never seen fails gate 1.
 */
export function declarationNoticeFor(
  target: { readonly directory?: string | undefined },
): PluginInstallNotice {
  if (target.directory === undefined) return { kind: 'unjudged' }
  const declaration = pluginDeclarationIn(target.directory)
  if (declaration === undefined) return { kind: 'undeclared' }
  const admitted = admitDeclaration(declaration)
  return 'error' in admitted ? { kind: 'invalid', error: admitted.error } : { kind: 'declared' }
}

/**
 * The gate-1 tag for one listed package, or `undefined` when it needs none.
 * The composition's own rows are not plugins a person installed, so an absent
 * declaration there is the normal state rather than a finding.
 */
function declarationTag(deps: PluginsInfoDeps, packageName: string): string | undefined {
  const verdict = declarationVerdict(deps, packageName)
  switch (verdict.kind) {
    case 'undeclared':
      return isCompositionOwned(packageName) ? undefined : t('plugins-tag-undeclared')
    case 'invalid':
      return t('plugins-tag-invalid', { err: verdict.error })
    case 'decided':
      return t('plugins-tag-declared', { state: stateText(verdict.decision) })
  }
}

/**
 * Display title of one loader entry: its own localized title, else the module
 * specifier it was loaded as (`./plugin-manager.ts` reads the field, which
 * `PluginInventoryEntry.meta` only carries after the 0.1.5 line — contract.ts:
 * additions must degrade gracefully on the older lines).
 */
function pluginRowTitle(plugin: PluginInfo): string {
  return cell(localizedPluginText(plugin, plugin.moduleName))
}

/** One bundle row: what the profile holds, how it is controlled, what it says. */
function bundleLine(deps: PluginsInfoDeps, bundle: BundleInfo, options: { readonly rows?: boolean } = {}): string {
  const flags: string[] = [bundle.enabled ? t('plugins-bundle-on') : t('plugins-bundle-off')]
  if (!bundle.removable) flags.push(t('plugins-bundle-kept'))
  if (bundle.readOnlyReason !== undefined) flags.push(t('plugins-bundle-locked', { reason: cell(bundle.readOnlyReason) }))
  if (bundle.error !== undefined) flags.push(t('plugins-bundle-problem', { code: cell(bundle.error.code) }))
  const tag = declarationTag(deps, bundle.name)
  if (tag !== undefined) flags.push(tag)
  const title = cell(localizedPluginText(bundle, bundle.name))
  const version = bundle.version === undefined ? '' : ` ${cell(bundle.version)}`
  // The row/override counts are detail: `/plugin info <name>` carries them, and
  // the short list drops them (`options.rows: false`).
  const tail = options.rows === false
    ? ''
    : ` · ${t('plugins-bundle-rows', { rows: String(bundle.rows.length), overrides: String(bundle.overrides.length) })}`
  return `  ${title}${version} · ${flags.join(' · ')}${tail}`
}

/** Whether a listed set needs the "no declaration" legend (composition rows never do). */
function needsDeclarationLegend(deps: PluginsInfoDeps, bundles: readonly BundleInfo[]): boolean {
  return bundles.some(bundle => !isCompositionOwned(bundle.name) && deps.declaration?.(bundle.name) === undefined)
}

/** One installation-supplied experimental bundle and its usage hint. */
interface ExperimentalEntry {
  readonly bundle: BundleInfo
  readonly hint: I18nKey
}

/**
 * The TUI experimental features this installation supplies, in catalog order.
 * A bundle the profile itself added (`installed: true`) is the person's own
 * plugin and stays in the "you added" section; only the installation-supplied
 * half is advertised here.
 */
function experimentalEntries(bundles: readonly BundleInfo[]): ExperimentalEntry[] {
  return TUI_EXPERIMENTAL_BUNDLES.flatMap(entry => {
    const bundle = bundles.find(candidate =>
      candidate.name === entry.name && candidate.optional && !candidate.installed)
    return bundle === undefined ? [] : [{ bundle, hint: entry.hint }]
  })
}

/** The switch line and the usage hint of one experimental bundle, when readable. */
function experimentalUsageLines(bundle: BundleInfo, hint: I18nKey): string[] {
  if (bundle.error !== undefined) return []
  return [
    `    ${t(bundle.enabled ? 'plugins-experimental-disable' : 'plugins-experimental-enable', { bundle: cell(bundle.name) })}`,
    `    ${t(hint)}`,
  ]
}

/** One experimental row: title, version and state, without plugin-declaration tags. */
function experimentalLine(bundle: BundleInfo): string {
  const flags = [t(bundle.enabled ? 'plugins-bundle-on' : 'plugins-bundle-off')]
  if (bundle.error !== undefined) flags.push(t('plugins-bundle-problem', { code: cell(bundle.error.code) }))
  const title = cell(localizedPluginText(bundle, bundle.name))
  const version = bundle.version === undefined ? '' : ` ${cell(bundle.version)}`
  return `  ${title}${version} · ${flags.join(' · ')}`
}

/** The experimental section; empty when the installation supplies none. */
function experimentalLines(entries: readonly ExperimentalEntry[]): string[] {
  if (entries.length === 0) return []
  const lines = [t('plugins-experimental-header', { count: String(entries.length) })]
  for (const { bundle, hint } of entries) {
    lines.push(experimentalLine(bundle))
    lines.push(...experimentalUsageLines(bundle, hint))
  }
  return lines
}

/** `/plugin list`: the plugins this profile added, then switchable experimental features. */
function listLines(deps: PluginsInfoDeps, bundles: readonly BundleInfo[]): string[] {
  const extras = extraBundles(bundles)
  const experimental = experimentalEntries(bundles)
  if (extras.length === 0 && experimental.length === 0) return [t('plugins-list-empty')]
  const lines: string[] = []
  if (extras.length === 0) {
    lines.push(t('plugins-list-empty'))
  } else {
    lines.push(t('plugins-list-header', { count: String(extras.length) }))
    for (const bundle of extras) lines.push(bundleLine(deps, bundle, { rows: false }))
    // The tag is explained once per report, next to the rows it qualifies: this
    // surface is a transcript, so there is nothing to click open (C-3).
    if (needsDeclarationLegend(deps, extras)) lines.push(t('plugins-tag-undeclared-hint'))
  }
  // Separate the two sections (and their entries) so the report reads as
  // blocks instead of one dense list.
  if (experimental.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(...experimentalLines(experimental))
  }
  return lines
}

/**
 * Official (installation-supplied) bundles first, then the profile's own. The
 * split is `installed` — the field that answers "do this profile's own
 * dependencies hold the package" — and not `optional`, which is narrower
 * (only the launcher's `OPTIONAL_BUNDLES`): an installation-supplied bundle no
 * shipped template preselects is `installed: false, optional: false` and would
 * land under the profile's own name.
 */
function bundleSectionLines(deps: PluginsInfoDeps, bundles: readonly BundleInfo[]): string[] {
  if (bundles.length === 0) return [t('plugins-bundles-empty')]
  const lines: string[] = [t('plugins-bundles-header')]
  const group = (label: string, group: readonly BundleInfo[]): void => {
    if (group.length === 0) return
    lines.push(` ${label}:`)
    for (const bundle of group) lines.push(bundleLine(deps, bundle))
  }
  group(t('plugins-bundles-official'), bundles.filter(bundle => !bundle.installed))
  group(t('plugins-bundles-installed'), bundles.filter(bundle => bundle.installed))
  if (needsDeclarationLegend(deps, bundles)) lines.push(t('plugins-tag-undeclared-hint'))
  return lines
}

/** Loader entries the profile cannot address through a patch row. */
function pluginRowLines(plugins: readonly PluginInfo[]): string[] {
  const unaddressable = plugins.filter(plugin => !('patchId' in plugin))
  if (unaddressable.length === 0) return []
  return [
    t('plugins-rows-header'),
    ...unaddressable.map(plugin => {
      const reason = plugin.readOnlyReason === undefined ? '' : cell(plugin.readOnlyReason)
      return `  ${pluginRowTitle(plugin)} · ${reason} · ${cell(plugin.entryId)}`
    }),
  ]
}

/** Everything a listed installed bundle carries, in full. */
function installedBundleLines(deps: PluginsInfoDeps, bundle: BundleInfo): string[] {
  const lines = [t('plugins-info-bundle', { name: cell(bundle.name) }), bundleLine(deps, bundle)]
  if (bundle.rows.length > 0) {
    lines.push(t('plugins-info-rows-label'))
    for (const row of bundle.rows) {
      const entry = row.entryId === undefined ? '' : ` · ${cell(row.entryId)}`
      lines.push(`    ${cell(row.rowId)} → ${cell(row.moduleName)}${entry}`)
    }
  }
  if (bundle.overrides.length > 0) {
    lines.push(t('plugins-info-overrides-label', { list: cell(bundle.overrides.join(', ')) }))
  }
  if (bundle.error !== undefined) {
    const diagnostic = bundle.error.diagnostic === undefined ? '' : ` — ${cell(bundle.error.diagnostic)}`
    lines.push(t('plugins-info-problem', { code: cell(bundle.error.code), diagnostic }))
  }
  return lines
}

/** What an installation spec names, before anything installs it. */
function inspectionLines(spec: string, inspection: PluginSpecInspection): string[] {
  if (inspection.status === 'refused') {
    return [t('plugins-info-inspect-refused', { problem: cell(inspection.problem), reason: cell(inspection.reason) })]
  }
  const lines = [t('plugins-info-inspect-accepted', {
    name: cell(inspection.name ?? spec),
    version: cell(inspection.version ?? ''),
    kind: cell(inspection.kind),
    bundle: inspection.bundle === null ? '?' : String(inspection.bundle),
    registry: urlCell(inspection.registry ?? ''),
  })]
  if (inspection.description !== undefined) {
    lines.push(t('plugins-info-inspect-description', { description: cell(inspection.description) }))
  }
  if (inspection.host !== undefined) lines.push(t('plugins-info-inspect-host', { host: urlCell(inspection.host) }))
  return lines
}

/** `/plugin info <spec>`: the installed bundle when one matches, else inspect. */
async function infoLines(deps: PluginsInfoDeps, manager: PluginManagerView, spec: string): Promise<string[]> {
  const installed = (await manager.listBundles()).find(bundle => bundle.name === spec)
  if (installed !== undefined) return installedBundleLines(deps, installed)
  return inspectionLines(spec, await manager.inspect(spec))
}

/** `/plugin registries`: the registries an installation asks, in order. */
function registriesLines(registries: PluginRegistries): string[] {
  const none = t('plugins-info-registries-none')
  const asCell = (value: string | null): string => value === null ? none : urlCell(value)
  // Redact per entry, then cap: the list is a comma-joined string, which no
  // single-URL pass could read.
  const fallbacks = registries.fallbackRegistries.length === 0
    ? none
    : cell(registries.fallbackRegistries.map(value => value === null ? 'null' : redactUrl(value)).join(', '))
  return [
    t('plugins-info-registries-header'),
    t('plugins-info-registries-first', { registry: asCell(registries.registry) }),
    t('plugins-info-registries-fallbacks', { list: fallbacks }),
    t('plugins-info-registries-resolved', { registry: asCell(registries.resolved) }),
  ]
}

/** The service-backed half of the report (empty for a form that needs no service). */
export async function pluginServiceLines(
  args: string,
  deps: PluginsInfoDeps,
  manager: PluginManagerView | undefined,
): Promise<string[]> {
  const parsed = parsePluginArgs(args)
  if (parsed.kind === 'check' || parsed.kind === 'unknown') return []
  if (parsed.kind === 'info' && parsed.spec === '') return []
  // With no service the report is the diagnostics plus the reason and the CLI
  // route, whatever the form asked for — the write path included: the flow that
  // would run it lives in the entry, and without a service the entry hands back
  // no flow, so this is the sentence the person reads.
  if (manager === undefined) return [t('plugins-service-unavailable'), t('plugins-service-unavailable-route')]
  // The write paths report themselves line by line as they run (C-4 / C-5): with
  // a service present, this half has nothing to add to them.
  if (parsed.kind === 'install' || parsed.kind === 'remove' || parsed.kind === 'enable' || parsed.kind === 'disable') return []
  // The service belongs to the host: a refusal or a crash there must not take
  // the diagnostics half down with it. Every call funnels into one line, so a
  // rejected promise still leaves a readable report instead of an unhandled
  // rejection and an empty screen.
  try {
    if (parsed.kind === 'list') return listLines(deps, await manager.listBundles())
    if (parsed.kind === 'registries') return registriesLines(await manager.registries())
    if (parsed.kind === 'info') return await infoLines(deps, manager, parsed.spec)
    const bundles = await manager.listBundles()
    const plugins = await manager.listPlugins()
    return [...bundleSectionLines(deps, bundles), ...pluginRowLines(plugins)]
  } catch (error) {
    return [t('plugins-service-error', { err: cell(error instanceof Error ? error.message : String(error)) })]
  }
}

/** `/plugin`: the diagnostics half plus the profile's own bundles and rows. */
export async function pluginReport(
  args: string,
  deps: PluginsInfoDeps,
  manager: PluginManagerView | undefined,
): Promise<string[]> {
  return [...pluginsInfoLines(args, deps), ...await pluginServiceLines(args, deps, manager)]
}
