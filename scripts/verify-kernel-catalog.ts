/**
 * The kernel catalog with the registry behind it (P0 D1/D2/D5): the entry list
 * is the registry's, in declaration order; names come from the manifests; only a
 * backend whose detection says `stale` reads "too old"; and the two-stage parse
 * (syntax, then membership) keeps every unknown value on the dsh fallback.
 *
 * Run: node --import tsx/esm scripts/verify-kernel-catalog.ts
 */
import assert from 'node:assert/strict'
import { buildKernelCatalog, kernelEntriesOf, kernelSubtitle } from '../src/components/kernelCatalog.js'
import type { KernelOption } from '../src/components/kernelCatalog.js'
import { setLang, t } from '../src/i18n.js'
import { isBackendIdSyntax } from '../src/agent/backend-manifest.js'
import { BUILTIN_BACKEND_IDS, parseBackendId, resolveRememberedBackend, resolveResumeTarget } from '../src/kernelPrefs.js'
import { normalizeBackendChoice } from '../src/dsh-adapter/index.js'
import { isRegisteredBackend, listBackends, parseBackendChoice } from '../src/dsh-adapter/backend-registry.js'
import { installSurfaceFor } from '../src/dsh-adapter/backends.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

// ── The registry is the single source of "which backends exist" ──────────────
const backends = listBackends()
const backendOf = (id: string) => backends.find(entry => entry.id === id)
// Additive on purpose (P0 §1.2): every built-in is looked up **by id**, never by
// position, so adding `src/backends/<id>/` cannot red these labels. The seed's
// position and the exact registry/directory parity live in verify-backend-registry.
const dsh = backendOf('dsh')
const claude = backendOf('claude')
const codex = backendOf('codex')
const codexLabel = codex?.manifest.label
check('the seed is dsh and every built-in manifest is registered',
  backends[0]?.id === 'dsh' && BUILTIN_BACKEND_IDS.every(id => backendOf(id) !== undefined), backends.map(entry => entry.id))
check('dsh: in-tree, always available, and not an AgentBackend (no loader)',
  dsh?.manifest.inTree === true && dsh.manifest.alwaysAvailable === true && dsh.load === undefined)
check('codex: label, product, short name and pool hook come from its manifest',
  codexLabel?.kind === 'key' && codexLabel.key === 'kernel-label-codex'
    && t('kernel-label-codex') === 'Codex' && codex?.manifest.product === 'codex-cli'
    && codex?.manifest.shortLabel === 'Codex' && codex?.manifest.unloadExport === 'closeAllCodexHubs')
// Whole-table, not name-by-name (review, scope note; B-1 restated it): the fact
// "this host can install me" is now derived — a declared recipe whose executor the
// host implements — so it is stated as a set. A fourth backend arriving installable
// reds here rather than slipping past a check that only ever asked about dsh and
// codex, and a recipe whose executor name drifts from the host's table reds here too
// (the entry would quietly stop being installable).
const installableIds = backends.filter(entry => entry.installable).map(entry => entry.id)
const recipeIds = backends.filter(entry => entry.manifest.install !== undefined).map(entry => entry.id)
check('only the Claude SDK is host-installable, and only it declares an install recipe',
  installableIds.join(',') === 'claude' && recipeIds.join(',') === 'claude'
    && claude?.manifest.install?.specifier.startsWith('@anthropic-ai/claude-agent-sdk@') === true)
const onlyInstallable = backends.find(entry => entry.installable)
check('the host wizard answers with the entry that declared it, executor and pin included',
  onlyInstallable !== undefined && installSurfaceFor('claude')?.specifier === onlyInstallable.manifest.install?.specifier
    && installSurfaceFor('claude')?.version === onlyInstallable.manifest.install?.version
    && installSurfaceFor('claude')?.executor === onlyInstallable.manifest.install?.executor
    // codex declares nothing: "no install surface" is an answer, not an error.
    && installSurfaceFor('codex') === undefined)

// ── The two-stage parse: syntax, then membership (D1) ────────────────────────
check('syntax gate passes a plugin-shaped id, the registry gate does not',
  isBackendIdSyntax('acme-agent') && parseBackendId(' Acme-Agent ') === 'acme-agent'
    && !isRegisteredBackend('acme-agent') && parseBackendChoice('acme-agent') === undefined)
check('codex is a registered id; --backend / DSH_TUI_BACKEND accept it (case-insensitive)',
  isRegisteredBackend('codex') && normalizeBackendChoice(' Codex ') === 'codex' && resolveRememberedBackend({ envRaw: 'codex' }) === 'codex')
check('an uninstalled-but-well-formed DSH_TUI_BACKEND falls back to dsh, never the memory',
  resolveRememberedBackend({ envRaw: 'acme-agent', memory: 'claude' }) === 'acme-agent'
    && resolveRememberedBackend({ envRaw: 'acme-agent', envKnown: isRegisteredBackend, memory: 'claude' }) === 'dsh'
    && resolveRememberedBackend({ envRaw: 'Acme Agent', envKnown: isRegisteredBackend, memory: 'claude' }) === 'dsh')

// ── A derived resume target belongs to the backend it came from (review R2) ──
// The launcher marks what it read out of another backend's prefs
// (RESUME_BACKEND_ENV); this boot may land elsewhere — an unregistered plugin id
// falls back to dsh, an unset DSH_TUI_BACKEND follows the remembered kernel — and
// the id must not follow it there. Since B-2a the refusal is a boot failure, not a
// cold start, so the shape carries "which backend it came from" plus whether the
// refusal may be soft (safe-mode retry only); the deep matrix lives in
// scripts/verify-resume-target.ts.
const targetOf = (input: Parameters<typeof resolveResumeTarget>[0]) => resolveResumeTarget(input)
const usable = targetOf({ sessionId: 'claude-1', sourceBackend: 'claude', backendChoice: 'claude' })
check('R2: a marked target is usable when its source is the backend this boot landed on',
  usable.kind === 'usable' && usable.sessionId === 'claude-1')
const revoked = targetOf({ sessionId: 'codex-1', sourceBackend: 'codex', backendChoice: 'dsh' })
check('R2: a marked target from another backend is revoked with its source, never usable',
  revoked.kind === 'revoked' && revoked.from === 'codex' && revoked.fatal
    && targetOf({ sessionId: 'dsh-1', sourceBackend: 'dsh', backendChoice: 'claude' }).kind === 'revoked')
check('R2: an unmarked target (--resume <id>, a Config row) is never revoked here',
  targetOf({ sessionId: 'typed-1', backendChoice: 'dsh' }).kind === 'usable')
check('R2: a blank target is no target, marked or not',
  targetOf({ sessionId: '   ', sourceBackend: 'claude', backendChoice: 'dsh' }).kind === 'none'
    && targetOf({ backendChoice: 'dsh' }).kind === 'none')

const entries = kernelEntriesOf(backends)
const entryOf = (id: string) => entries.find(entry => entry.id === id)
check('the projection carries the manifest names the picker paints',
  entryOf('dsh')?.shortLabel === 'DSH' && entryOf('claude')?.shortLabel === 'Claude' && entryOf('codex')?.shortLabel === 'Codex'
    && entryOf('claude')?.label.kind === 'key' && entryOf('claude')?.alwaysAvailable === false && entryOf('claude')?.installable === true)

// ── Rows ─────────────────────────────────────────────────────────────────────
const rowOf = (options: readonly KernelOption[], id: string) => options.find(option => option.id === id)
const probing = buildKernelCatalog({ current: 'dsh', entries, canInstallSdk: true })
check('probing: dsh selectable, the others dim and "checking"',
  rowOf(probing, 'dsh')?.selectable === true && probing.filter(option => option.id !== 'dsh').every(option => !option.selectable && option.reasonKey === 'kernel-probing'))

const ready = buildKernelCatalog({ current: 'codex', entries, dshVersion: '0.2.0', statuses: { claude: { installed: true, auth: 'ok', version: '2.1.0' }, codex: { installed: true, auth: 'ok', version: '0.160.1' } } })
const codexRow = rowOf(ready, 'codex')!
check('ready: codex selectable, current, product-prefixed version', codexRow.selectable && codexRow.current && codexRow.version === 'codex-cli v0.160.1' && kernelSubtitle(codexRow, key => t(key)) === 'codex-cli v0.160.1')

const missing = buildKernelCatalog({ current: 'dsh', entries, canInstallSdk: true, statuses: { claude: { installed: false }, codex: { installed: false } } })
check('not installed: Claude offers the install wizard, Codex only says not installed', rowOf(missing, 'claude')?.installable === true && rowOf(missing, 'claude')?.reasonKey === 'kernel-not-installed-installable'
  && rowOf(missing, 'codex')?.installable === undefined && rowOf(missing, 'codex')?.reasonKey === 'kernel-unavailable-not-installed' && rowOf(missing, 'codex')?.selectable === false)

// Too old: the *detection* says so (`stale`), not an id comparison in the UI —
// a version without the flag is an ordinary install miss (D5-2).
const tooOld = buildKernelCatalog({ current: 'dsh', entries, canInstallSdk: true, statuses: { codex: { installed: false, stale: true, version: '0.100.0', hint: 'upgrade codex' } } })
check('too old: dim, "too old" reason and the upgrade hint carried',
  rowOf(tooOld, 'codex')?.selectable === false && rowOf(tooOld, 'codex')?.reasonKey === 'kernel-unavailable-too-old' && rowOf(tooOld, 'codex')?.hint === 'upgrade codex', rowOf(tooOld, 'codex'))
const versionOnly = buildKernelCatalog({ current: 'dsh', entries, canInstallSdk: true, statuses: { codex: { installed: false, version: '0.100.0' } } })
check('a version without `stale` is not "too old"', rowOf(versionOnly, 'codex')?.reasonKey === 'kernel-unavailable-not-installed', rowOf(versionOnly, 'codex'))

const signedOut = buildKernelCatalog({ current: 'dsh', entries, statuses: { claude: { installed: true, auth: 'missing' }, codex: { installed: true, auth: 'missing', loginInSession: true } } })
check('signed out: still selectable with no dim reason (credentials may live where detection cannot see)',
  rowOf(signedOut, 'claude')?.selectable === true && rowOf(signedOut, 'claude')?.reasonKey === undefined && rowOf(signedOut, 'claude')?.noteKey === undefined)
check('signed out + loginInSession: selectable with a "sign in after start" note',
  rowOf(signedOut, 'codex')?.selectable === true && rowOf(signedOut, 'codex')?.reasonKey === undefined && rowOf(signedOut, 'codex')?.noteKey === 'kernel-login-in-session'
    && kernelSubtitle(rowOf(signedOut, 'codex')!, key => t(key)) === t('kernel-login-in-session'))

const unknownAuth = buildKernelCatalog({ current: 'dsh', entries, statuses: { codex: { installed: true, auth: 'unknown', version: '0.170.0' } } })
check('auth unknown (a keychain): selectable, no note', rowOf(unknownAuth, 'codex')?.selectable === true && rowOf(unknownAuth, 'codex')?.noteKey === undefined)

console.log(`\nverify-kernel-catalog OK (${passed} checks)`)
