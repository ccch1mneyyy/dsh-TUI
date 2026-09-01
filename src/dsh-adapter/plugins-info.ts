/**
 * /plugins diagnostics surface (C-070 trust disclosure + C-030 negotiation
 * diagnostics): assembles the lines behind the `/plugins` command.
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
 *    in the effect ledger, and storage namespaces on disk (the host cannot
 *    enumerate installed plugins — that knowledge lives in the dsh CLI
 *    Loader). The header says so honestly.
 * 4. LEDGER TAIL — the last 5 effect-ledger records.
 *
 * `/plugins check <path>` uses the parser and projection from the pinned
 * @dsh-std/manifest revision, then evaluates every public/private protocol
 * through one ProtocolCatalog. Manifests and on-disk files are UNTRUSTED input:
 * every derived line passes cleanScalarText before it reaches the
 * transcript.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseManifest, projectManifest } from '../adapter/standard/protocols.js'
import { DATA_DIR } from '../utils/paths.js'
import { t } from '../i18n.js'
import { loadSpecData } from '../adapter/standard/registry.js'
import { createContractIndex, validatePlugin, negotiate } from '../adapter/standard/admission.js'
import type { NegotiationDecision } from '../adapter/standard/types.js'
import { cleanScalarText } from './sanitize.js'
import type { GrantStore } from '../adapter/standard/grants.js'
import type { HostDescriptorBuild } from '../adapter/standard/descriptor.js'
import { PLUGIN_STORAGE_DIR } from './plugin-storage.js'
import { EFFECT_LEDGER_FILE } from './effect-ledger.js'

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

const cell = (value: unknown): string => cleanScalarText(String(value ?? ''), LINE_CELLS)

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

/** The plugin set for the matrix: grants-file keys ∪ ledger pluginIds ∪
 *  storage namespaces ('host'/'undeclared' ledger identities are not
 *  plugins and are excluded). */
function footprintPlugins(deps: PluginsInfoDeps, dataDir: string, ledgerFile: string, storageDir: string): string[] {
  const found = new Set<string>()
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, 'extension-grants.json'), 'utf8'))
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
  for (const record of readLedgerRecords(ledgerFile)) {
    if (typeof record.pluginId === 'string' && record.pluginId !== '' && record.pluginId !== 'host' && record.pluginId !== 'undeclared') {
      found.add(record.pluginId)
    }
  }
  try {
    for (const entry of readdirSync(storageDir)) {
      if (!entry.endsWith('.json')) continue
      const namespace = decodeURIComponent(entry.slice(0, -'.json'.length))
      if (namespace !== '') found.add(namespace)
    }
  } catch {
    // No storage directory yet: no rows from this source.
  }
  void deps
  return [...found].sort()
}

/** `/plugins check <path>`: official parse/projection + profile validation + negotiation. */
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
      // `/plugins check` has no live activation instance. Passing an
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

function decisionLines(decision: NegotiationDecision): string[] {
  switch (decision.decision) {
    case 'compatible':
      return [t('plugins-check-state', { state: 'compatible' })]
    case 'compatible_degraded':
      return [t('plugins-check-state', {
        state: `compatible_degraded (missingOptional: ${cell(decision.missingOptional.join(', '))})`,
      })]
    case 'waiting_authorization':
      return [t('plugins-check-state', {
        state: `waiting_authorization (${cell(decision.reasonCode)}: ${cell(decision.deniedPermissions.join(', '))})`,
      })]
    case 'rejected': {
      const detail = decision.missingRequired !== undefined
        ? `${cell(decision.reasonCode)}: ${cell(decision.missingRequired.join(', '))}`
        : `${cell(decision.reasonCode)}: facet ${cell(decision.facetApiVersion)} vs host [${cell((decision.hostFacetApiVersions ?? []).join(', '))}]`
      return [t('plugins-check-state', { state: `rejected (${detail})` })]
    }
    case 'unknown':
      return [t('plugins-check-state', {
        state: `unknown (${cell(decision.reasonCode)}: ${cell(decision.unknownContracts.join(', '))})`,
      })]
  }
}

/** The `/plugins` overview lines (banner always first). */
export function pluginsInfoLines(args: string, deps: PluginsInfoDeps): string[] {
  const lines: string[] = [t('plugins-trust-banner')]
  const trimmed = args.trim()
  if (trimmed !== '') {
    const [sub, ...rest] = trimmed.split(/\s+/)
    if (sub === 'check') {
      const pathArg = rest.join(' ')
      if (pathArg === '') {
        lines.push(t('plugins-check-usage'))
        return lines
      }
      lines.push(...checkManifestLines(pathArg, deps))
      return lines
    }
    lines.push(t('plugins-unknown-subcommand', { sub: cell(sub) }))
    return lines
  }

  const dataDir = deps.dataDir ?? DATA_DIR
  const ledgerFile = deps.ledgerFile ?? EFFECT_LEDGER_FILE
  const storageDir = deps.storageDir ?? join(dataDir, PLUGIN_STORAGE_DIR)

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
  const plugins = footprintPlugins(deps, dataDir, ledgerFile, storageDir)
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
