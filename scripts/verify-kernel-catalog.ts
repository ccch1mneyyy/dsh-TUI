/**
 * The kernel catalog with three kernels (docs/codex-backend-design.md N7):
 * DSH always selectable; Claude and Codex dim while probing, when not
 * installed, or when signed out — unless the backend can sign in after start
 * (`loginInSession`), which keeps the row selectable with a note; only a
 * kernel the host can install (Claude's SDK wizard) offers "Enter to
 * install"; versions carry their product prefix; the kernel id and display
 * name vocabularies agree.
 *
 * Run: node --import tsx/esm scripts/verify-kernel-catalog.ts
 */
import assert from 'node:assert/strict'
import { buildKernelCatalog, kernelDisplayName, kernelSubtitle } from '../src/components/kernelCatalog.js'
import { setLang, t } from '../src/i18n.js'
import { isKernelId, KERNEL_IDS, KERNEL_INFO, resolveRememberedBackend } from '../src/kernelPrefs.js'
import { normalizeBackendChoice } from '../src/dsh-adapter/index.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

check('three kernels, in picker order', KERNEL_IDS.join(',') === 'dsh,claude,codex')
check('codex: label, product, display name', KERNEL_INFO.codex.labelKey === 'kernel-label-codex' && t(KERNEL_INFO.codex.labelKey) === 'Codex' && KERNEL_INFO.codex.product === 'codex-cli' && kernelDisplayName('codex') === 'Codex')
check('only the Claude SDK is host-installable', KERNEL_INFO.claude.installable && !KERNEL_INFO.codex.installable && !KERNEL_INFO.dsh.installable)
check('codex is a kernel id; --backend / DSH_TUI_BACKEND accept it (case-insensitive)', isKernelId('codex') && normalizeBackendChoice(' Codex ') === 'codex' && resolveRememberedBackend({ envRaw: 'codex' }) === 'codex')

const probing = buildKernelCatalog({ current: 'dsh', canInstallSdk: true })
check('probing: dsh selectable, the others dim and "checking"', probing[0]!.selectable && probing.slice(1).every(option => !option.selectable && option.reasonKey === 'kernel-probing'))

const ready = buildKernelCatalog({ current: 'codex', dshVersion: '0.2.0', statuses: { claude: { installed: true, auth: 'ok', version: '2.1.0' }, codex: { installed: true, auth: 'ok', version: '0.160.1' } } })
const codex = ready.find(option => option.id === 'codex')!
check('ready: codex selectable, current, product-prefixed version', codex.selectable && codex.current && codex.version === 'codex-cli v0.160.1' && kernelSubtitle(codex, key => t(key)) === 'codex-cli v0.160.1')

const missing = buildKernelCatalog({ current: 'dsh', canInstallSdk: true, statuses: { claude: { installed: false }, codex: { installed: false } } })
check('not installed: Claude offers the install wizard, Codex only says not installed', missing[1]!.installable === true && missing[1]!.reasonKey === 'kernel-not-installed-installable'
  && missing[2]!.installable === undefined && missing[2]!.reasonKey === 'kernel-unavailable-not-installed' && !missing[2]!.selectable)

const signedOut = buildKernelCatalog({ current: 'dsh', statuses: { claude: { installed: true, auth: 'missing' }, codex: { installed: true, auth: 'missing', loginInSession: true } } })
check('signed out: a row without in-session login stays dim', !signedOut[1]!.selectable && signedOut[1]!.reasonKey === 'kernel-unavailable-auth-missing')
check('signed out + loginInSession: selectable with a "sign in after start" note', signedOut[2]!.selectable && signedOut[2]!.reasonKey === undefined && signedOut[2]!.noteKey === 'kernel-login-in-session'
  && kernelSubtitle(signedOut[2]!, key => t(key)) === t('kernel-login-in-session'))

const unknownAuth = buildKernelCatalog({ current: 'dsh', statuses: { codex: { installed: true, auth: 'unknown', version: '0.170.0' } } })
check('auth unknown (a keychain): selectable, no note', unknownAuth[2]!.selectable && unknownAuth[2]!.noteKey === undefined)

console.log(`\nverify-kernel-catalog OK (${passed} checks)`)
