/**
 * i18n 字典静态门禁（verify:build 的一环）：类型系统管不到的三类静默失败——
 *   1. 语言完整性：非 cmd-desc-* 条目必须同时携带 zh 与 en（cmd-desc-* 的 en
 *      真源在命令注册表，字典只带 zh，见 i18n.ts 的 tOr 注释）；
 *   2. 占位符：单花括号 `{name}` 是 `{{name}}` 的手误，t() 不替换、原样上屏；
 *      zh/en 的 `{{name}}` 名字集合互不为子集时视为改名漂移（一侧刻意省略
 *      占位符是合法本地化，如 en 单数句去掉 {{n}}，所以只拦"两侧都有但
 *      名字对不上"）；
 *   3. 死 key：src/ 与 scripts/ 里没有任何字面引用、又不属于运行时拼接
 *      前缀家族的条目。拼接家族（tOr(`cmd-desc-${name}`) 等）按前缀放行。
 * 运行：node --import tsx/esm scripts/verify-i18n.ts
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { i18nDict, type I18nText } from '../src/i18n.js'

// 运行时拼接的 key 前缀（新增拼接家族时在此登记，并附拼接点）：
//   cmd-desc-*    src/commands.ts        tOr(`cmd-desc-${command.name}`)
//   traj-sort-*   src/screens/TrajectoryScene.tsx  t(`traj-sort-${sort}`)
//   traj-proj-*   src/screens/TrajectoryScene.tsx  t(`traj-proj-${projection}`)
//   logo-drift-*  src/components/LogoV2.tsx        tOr(`logo-drift-${kind}`)
//   tree-filter-* src/screens/SessionTree.tsx      t(`tree-filter-${filter}`)
//   tree-kind-*   src/screens/SessionTree.tsx      t(`tree-kind-${entry.kind}`)
//   preset-name-* / preset-desc-*   src/dsh-adapter/channel.ts   tOr(`preset-name-${preset.id}`) — built-in preset display text
const DYNAMIC_PREFIXES = ['cmd-desc-', 'traj-sort-', 'traj-proj-', 'logo-drift-', 'tree-filter-', 'tree-kind-', 'preset-name-', 'preset-desc-']

let failures = 0
function fail(msg: string) {
  failures++
  console.error(`  ✗ ${msg}`)
}

function forms(text: I18nText | undefined): string[] {
  if (text === undefined) return []
  return typeof text === 'string' ? [text] : [text.one, text.other]
}

function placeholders(text: I18nText | undefined): Set<string> {
  const names = new Set<string>()
  for (const form of forms(text)) {
    for (const m of form.matchAll(/\{\{(\w+)\}\}/g)) names.add(m[1]!)
  }
  return names
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (!b.has(x)) return false
  return true
}

// ── 1+2：逐条目检查语言完整性与占位符 ─────────────────────────────────
const singleBrace = /(?<!\{)\{(\w+)\}(?!\})/
for (const [key, entry] of Object.entries(i18nDict)) {
  if (entry.zh === undefined) fail(`${key}: 缺 zh`)
  if (entry.en === undefined && !key.startsWith('cmd-desc-')) fail(`${key}: 缺 en`)
  for (const lang of ['zh', 'en'] as const) {
    for (const form of forms(entry[lang])) {
      const m = singleBrace.exec(form)
      if (m) fail(`${key}.${lang}: 单花括号 {${m[1]}}——t() 不替换，应为 {{${m[1]}}}`)
    }
  }
  const zh = placeholders(entry.zh)
  const en = placeholders(entry.en)
  if (entry.en !== undefined && !isSubset(zh, en) && !isSubset(en, zh)) {
    fail(`${key}: 占位符名不一致 zh={{${[...zh].join(',')}}} en={{${[...en].join(',')}}}`)
  }
}

// ── 3：死 key（src/ 与 scripts/ 全量字面扫描 + 拼接前缀放行）──────────
const files = execSync('git ls-files src scripts', { encoding: 'utf8' })
  .trim().split('\n')
  .filter(f => /\.(ts|tsx|mjs|cjs|js)$/.test(f))
  .filter(f => f !== 'src/i18n.ts' && f !== 'scripts/verify-i18n.ts')
let corpus = ''
for (const f of files) corpus += readFileSync(f, 'utf8')
for (const key of Object.keys(i18nDict)) {
  if (DYNAMIC_PREFIXES.some(p => key.startsWith(p))) continue
  if (!corpus.includes(`'${key}'`) && !corpus.includes(`"${key}"`) && !corpus.includes(`\`${key}\``)) {
    fail(`${key}: 死 key——src/ 与 scripts/ 无引用（运行时拼接的 key 请登记 DYNAMIC_PREFIXES）`)
  }
}

const total = Object.keys(i18nDict).length
if (failures > 0) {
  console.error(`verify-i18n: ${total} 条目，${failures} 处失败`)
  process.exit(1)
}
console.log(`✓ verify-i18n: ${total} 条目——语言完整、占位符一致、无死 key`)
