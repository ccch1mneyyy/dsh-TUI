/**
 * 批 C-5 第 1 件：门禁 2 的守卫（`src/dsh-adapter/plugin-guard.ts`）。
 *
 *   A. 核心清单是**字面量事实**：公开包 + 私有 runtime + `dsh-base`，且长度恰 3；
 *      `CORE_ROW_PREFIX` 就是本包名 —— 加一个"核心"必须是一次会被本门禁看见的改动；
 *   B. 判定矩阵：bundle / 行 × remove / enable / disable × 命中 / 不命中，逐条断言
 *      `kind` 与 `reason`。其中两条**方向不对称**是这张表的重点：`enable` 对核心
 *      bundle 与本包的行**一律放行**（它是复原动作，把手工改坏的 profile 关在门外
 *      等于封死唯一的 UI 退路），而上游的锁（`service-locked`）**双向都拒**；
 *   C. 前缀规则的边界：本包名与其**子路径**是核心，`…-extra` 之类同前缀的别的包不是；
 *      逐字比较，不做大小写 / 空白宽容；
 *   D. 守卫**不读 hmr**：源码级断言（零 `hmr` 词元 + 只 import 一个常量模块）。上游
 *      `stop-profile` 守卫在 `patchReload: live` 下失效，门禁 2 必须在那条路径上照样拒
 *      —— 把这条变成可红的机器事实，而不是注释里的承诺。
 *
 * 强制点自身（"写入前先问守卫"）由 `verify-plugin-manager-chat.tsx` 的 C-5 段与
 * `plugin-manage.ts` 的存在性断言负责，本文件只管判据。
 *
 * Run via `node --import tsx/esm scripts/verify-plugin-guard.ts`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMPOSITION_PACKAGE } from '../src/dsh-adapter/plugin-declaration.js'
import { RUNTIME_BUNDLE } from '../src/dsh-adapter/market/runtime-profile.mjs'
import {
  CORE_BUNDLES,
  CORE_ROW_PREFIX,
  HOST_BUNDLE,
  pluginGuardVerdict,
  type PluginGuardAction,
  type PluginGuardTarget,
} from '../src/dsh-adapter/plugin-guard.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) throw new Error(`${label}\n${detail}`)
  passed += 1
  console.log(`PASS ${label}`)
}

// ── A. 核心清单是字面量事实 ───────────────────────────────────────────────────
check('the core bundle list is exactly the public application, private runtime and host layer',
  CORE_BUNDLES.length === 3 && CORE_BUNDLES[0] === COMPOSITION_PACKAGE && CORE_BUNDLES[1] === RUNTIME_BUNDLE && CORE_BUNDLES[2] === '@deepseek-ai/dsh-base',
  JSON.stringify(CORE_BUNDLES))
check('the host bundle constant is dsh-base',
  HOST_BUNDLE === '@deepseek-ai/dsh-base', HOST_BUNDLE)
check('the core row prefix is this application\'s own package name',
  CORE_ROW_PREFIX === COMPOSITION_PACKAGE, `${CORE_ROW_PREFIX} vs ${COMPOSITION_PACKAGE}`)

// ── B. 判定矩阵 ──────────────────────────────────────────────────────────────
type Expected = { readonly kind: 'allowed' } | { readonly kind: 'refused'; readonly reason: string }

const bundle = (name: string, removable = true, readOnlyReason?: string): PluginGuardTarget =>
  ({ kind: 'bundle', name, removable, readOnlyReason })
const row = (moduleName: string, readOnlyReason?: string, ownRow?: boolean): PluginGuardTarget =>
  ({ kind: 'row', entryId: `entry:${moduleName}`, moduleName, patchId: readOnlyReason === undefined ? `patch:${moduleName}` : undefined, ownRow, readOnlyReason })
/** A row this application's own patch inserts, loading a first-party module. */
const OWN_FIRST_PARTY_ROW = '@deepseek-ai/dsh-storage'

const ALLOWED: Expected = { kind: 'allowed' }
const refused = (reason: string): Expected => ({ kind: 'refused', reason })

const APP = COMPOSITION_PACKAGE
/** A bundle nobody would call core: some plugin a person installed. */
const THIRD_PARTY = '@probe/some-plugin'
/** A row of the host layer: legitimate to switch off, but a service may go with it. */
const HOST_ROW_MODULE = '@deepseek-ai/dsh-host-webserver'

const MATRIX: readonly (readonly [string, PluginGuardTarget, PluginGuardAction, Expected])[] = [
  // The application's own bundle: never removed, never disabled, always repairable.
  ['the application bundle is not removed', bundle(APP), 'remove', refused('app-bundle')],
  ['the application bundle is not disabled', bundle(APP), 'disable', refused('app-bundle')],
  ['the application bundle can be switched back on', bundle(APP), 'enable', ALLOWED],
  ['the private runtime bundle is not removed', bundle(RUNTIME_BUNDLE), 'remove', refused('app-bundle')],
  ['the private runtime bundle is not disabled', bundle(RUNTIME_BUNDLE), 'disable', refused('app-bundle')],
  ['the private runtime bundle can be switched back on', bundle(RUNTIME_BUNDLE), 'enable', ALLOWED],
  ['a similarly named bundle remains a third-party plugin', bundle(`${RUNTIME_BUNDLE}-extra`), 'disable', ALLOWED],
  // The host layer the application is stacked on.
  ['the host bundle is not removed', bundle(HOST_BUNDLE), 'remove', refused('host-bundle')],
  ['the host bundle is not disabled', bundle(HOST_BUNDLE), 'disable', refused('host-bundle')],
  ['the host bundle can be switched back on', bundle(HOST_BUNDLE), 'enable', ALLOWED],
  // Everything else: the guard has no objection, the flow decides about asking.
  ['a third-party bundle is removed', bundle(THIRD_PARTY), 'remove', ALLOWED],
  ['a third-party bundle is disabled', bundle(THIRD_PARTY), 'disable', ALLOWED],
  ['a third-party bundle is enabled', bundle(THIRD_PARTY), 'enable', ALLOWED],
  // The host said it is not removable (the launcher installed it).
  ['a bundle the host calls not removable is not removed', bundle(THIRD_PARTY, false), 'remove', refused('not-removable')],
  ['a bundle the host calls not removable can still be switched off', bundle(THIRD_PARTY, false), 'disable', ALLOWED],
  ['a bundle the host calls not removable can be switched on', bundle(THIRD_PARTY, false), 'enable', ALLOWED],
  // Rows. A row never leaves on its own; which rows may be switched off is the point.
  ['a row is never removed on its own', row(HOST_ROW_MODULE), 'remove', refused('row-not-removable')],
  ['a third-party row is not removed on its own either', row(THIRD_PARTY), 'remove', refused('row-not-removable')],
  ['this application\'s own row is not disabled', row(APP), 'disable', refused('app-row')],
  ['this application\'s own row can be switched back on', row(APP), 'enable', ALLOWED],
  ['a host-layer row can be switched off', row(HOST_ROW_MODULE), 'disable', ALLOWED],
  ['a host-layer row can be switched on', row(HOST_ROW_MODULE), 'enable', ALLOWED],
  ['a third-party row can be switched off', row(THIRD_PARTY), 'disable', ALLOWED],
  // The measured half of the row rule: this bundle's patch inserts rows that load
  // first-party modules (the composition's storage / workspace / webserver seams),
  // and the host protects only one of them. What makes them ours is that our own
  // patch inserts them, not the name they load.
  ['a row this application\'s own patch inserts is not disabled', row(OWN_FIRST_PARTY_ROW, undefined, true), 'disable', refused('app-row')],
  ['the same row is switchable when the snapshot does not call it ours', row(OWN_FIRST_PARTY_ROW, undefined, false), 'disable', ALLOWED],
  ['an own row can always be switched back on', row(OWN_FIRST_PARTY_ROW, undefined, true), 'enable', ALLOWED],
  ['a row of ours is not removed on its own either', row(OWN_FIRST_PARTY_ROW, undefined, true), 'remove', refused('row-not-removable')],
  ['the host lock still outranks the own-row rule', row(OWN_FIRST_PARTY_ROW, 'unaddressable', true), 'disable', refused('service-locked')],
  ['a third-party row can be switched on', row(THIRD_PARTY), 'enable', ALLOWED],
  // The host's own lock: neither direction is ours, and the guard says so rather than
  // re-deriving a reason of its own.
  ['a locked bundle is refused when removed', bundle(THIRD_PARTY, false, 'management-required'), 'remove', refused('service-locked')],
  ['a locked bundle is refused when disabled', bundle(THIRD_PARTY, false, 'management-required'), 'disable', refused('service-locked')],
  ['a locked bundle is refused when enabled', bundle(THIRD_PARTY, false, 'management-required'), 'enable', refused('service-locked')],
  ['a locked row is refused when disabled', row(THIRD_PARTY, 'unaddressable'), 'disable', refused('service-locked')],
  ['a locked row is refused when enabled', row(THIRD_PARTY, 'unaddressable'), 'enable', refused('service-locked')],
  ['a locked row is refused when removed', row(THIRD_PARTY, 'unaddressable'), 'remove', refused('service-locked')],
]

for (const [label, target, action, expected] of MATRIX) {
  const verdict = pluginGuardVerdict(target, action)
  check(`${label} (${action} ⇒ ${expected.kind}${expected.kind === 'refused' ? `/${expected.reason}` : ''})`,
    verdict.kind === expected.kind && (verdict.kind !== 'refused' || verdict.reason === expected.reason),
    JSON.stringify(verdict))
}

// The host's lock outranks every rule of ours: a locked target that also happens to be
// the application bundle must still report the host's reason, not ours.
const lockedApp = pluginGuardVerdict(bundle(APP, false, 'management-required'), 'disable')
check('the host lock is reported as such even on a core bundle',
  lockedApp.kind === 'refused' && lockedApp.reason === 'service-locked', JSON.stringify(lockedApp))

// ── C. 前缀规则的边界 ─────────────────────────────────────────────────────────
const PREFIX_CASES: readonly (readonly [string, string, Expected])[] = [
  ['the package itself', APP, refused('app-row')],
  ['a subpath of the package', `${APP}/contrib`, refused('app-row')],
  ['a deeper subpath', `${APP}/channel/extensions`, refused('app-row')],
  ['a sibling whose name merely starts the same', `${APP}-extra`, ALLOWED],
  ['a sibling without the separator', `${APP}x`, ALLOWED],
  ['the scope alone', '@deepseek-harness-tui', ALLOWED],
  ['the same name in another case', APP.toUpperCase(), ALLOWED],
  ['the same name with leading whitespace', ` ${APP}`, ALLOWED],
  ['the same name with trailing whitespace', `${APP} `, ALLOWED],
  ['a row whose module is empty', '', ALLOWED],
]
for (const [label, moduleName, expected] of PREFIX_CASES) {
  const verdict = pluginGuardVerdict(row(moduleName), 'disable')
  check(`the core row prefix is matched verbatim (${label})`,
    verdict.kind === expected.kind && (verdict.kind !== 'refused' || verdict.reason === expected.reason),
    JSON.stringify(verdict))
}

// ── D. 守卫不读 hmr（源码级） ─────────────────────────────────────────────────
const source = readFileSync(join(ROOT, 'src', 'dsh-adapter', 'plugin-guard.ts'), 'utf8')

/**
 * Blank out comments and string/template bodies, keeping every character
 * position. The claim under test is about what the guard *does*, and its header
 * has to be free to explain the HMR hole it exists to close — so the assertion
 * reads code, not prose. Keeping the length means line numbers survive.
 */
function codeOnly(text: string): string {
  const out = [...text]
  let index = 0
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') out[index++] = ' '
    } else if (char === '/' && next === '*') {
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) out[index++] = ' '
      out[index++] = ' '
      out[index++] = ' '
    } else if (char === '\'' || char === '"' || char === '`') {
      const quote = char
      index += 1
      while (index < text.length && text[index] !== quote) {
        if (text[index] === '\\') out[index++] = ' '
        out[index++] = ' '
      }
      index += 1
    } else {
      index += 1
    }
  }
  return out.join('')
}

const code = codeOnly(source)
check('the guard never reads hmr, so hot reload cannot change its answer',
  !/\bhmr\b/iu.test(code), code.split('\n').filter(line => /\bhmr\b/iu.test(line)).join('\n'))
check('the guard reaches for no service, no filesystem and no clock (no other import)',
  [...source.matchAll(/^import\s[\s\S]*?from\s+'([^']+)'/gmu)].map(match => match[1]).join(',') === './plugin-declaration.js',
  JSON.stringify([...source.matchAll(/^import\s[\s\S]*?from\s+'([^']+)'/gmu)].map(match => match[1])))

// ── E. 强制点存在（源码级：判据没有消费者就只是一段注释） ─────────────────────
// 行为面（"拒了之后一次服务调用都没有"）由假服务电池的 C-5 段驱动真实流程断言；
// 这里只钉住**结构**：守卫与写入在流程里的相对位置。三条计数都是有意为之的
// 绊线，照 A 组"核心清单恰 3 项"的先例——数字变了就是一次要有人解释的改动。
const manage = readFileSync(join(ROOT, 'src', 'dsh-adapter', 'plugin-manage.ts'), 'utf8')
const manageImports = [...manage.matchAll(/^import[\s\S]*?from\s+'([^']+)'/gmu)].map(match => match[1])
check('the manage flow imports the guard it has to run',
  manageImports.includes('./plugin-guard.js'), JSON.stringify(manageImports))

const guardCall = manage.indexOf('pluginGuardVerdict(')
const writeFunction = manage.indexOf('async function write(')
const refusalBranch = manage.indexOf("if (verdict.kind === 'refused')")
check('the guard is called, and refuses, before the write function is even defined',
  guardCall !== -1 && refusalBranch !== -1 && writeFunction !== -1 && guardCall < refusalBranch && refusalBranch < writeFunction,
  `guard@${guardCall} refusal@${refusalBranch} write@${writeFunction}`)

// 唯一的写入漏斗：三个动作各一处服务写口，且只有 `run()` 里那一次 `write(current)`。
// 多出第四个写口、或绕开漏斗直接调服务，都会让计数变红。
const writeCalls = [...manage.matchAll(/options\.manager\.(?:removeBundle|setBundleEnabled|setPluginEnabled)\b/gu)].length
const funnelCalls = [...manage.matchAll(/\bwrite\(current\)/gu)].length
check('every write goes through the one funnel the guard sits above',
  writeCalls === 3 && funnelCalls === 1, `writes=${writeCalls} funnels=${funnelCalls}`)

// 两条解析分支（bundle 名 / 行身份）都必须过守卫：定义一次 + 调用两次。
const guardGates = [...manage.matchAll(/\bguardThenDecide\(/gu)].length
check('both resolutions run the guard, and nothing else decides',
  guardGates === 3, `guardThenDecide=${guardGates}`)

console.log(`verify-plugin-guard OK (${passed} checks)`)
