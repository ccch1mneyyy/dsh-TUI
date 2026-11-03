/**
 * i18n 字典静态门禁（verify:build 的一环）：类型系统管不到的六类静默失败——
 *   1. 语言完整性：非 cmd-desc-* 条目必须同时携带 zh 与 en（cmd-desc-* 的 en
 *      真源在命令注册表，字典只带 zh，见 i18n.ts 的 tOr 注释）；
 *   2. 占位符：单花括号 `{name}` 是 `{{name}}` 的手误，t() 不替换、原样上屏；
 *      zh/en 的 `{{name}}` 名字集合互不为子集时视为改名漂移（一侧刻意省略
 *      占位符是合法本地化，如 en 单数句去掉 {{n}}，所以只拦"两侧都有但
 *      名字对不上"）；
 *   3. 死 key：src/ 与 scripts/ 里没有任何字面引用、又不属于运行时拼接
 *      前缀家族的条目。拼接家族（tOr(`cmd-desc-${name}`) 等）按前缀放行；
 *   4. 英文文案字面量：整句级 UI 英文（折叠提示、终止信号句）只允许活在
 *      字典里，src/ 其他文件出现即打回（issue #980 的漏网形态——键已存在
 *      而组件绕过 t() 硬编码）。scripts/ 的夹具断言 en 输出属合法，不查；
 *   5. 后端自带文案（B-3/B-5）：注册的后端字典按同样规则查语言完整性与占位符；
 *   6. 跨字典一致性：与后端共用的平台文案只有一处真源
 *      （src/backends/shared/platform-text.ts）——宿主字典与两个后端各自展开
 *      它，逐字比对；任一侧写回一份不同的内联副本（同名键在展开之后会覆盖
 *      真源）即红。防的是"副本被重新引入"。
 * 运行：node --import tsx/esm scripts/verify-i18n.ts
 */
import { execFileSync } from 'node:child_process'
import ts from 'typescript'
import { existsSync, readFileSync } from 'node:fs'
import { i18nDict, type I18nText } from '../src/i18n.js'
import { claudeTexts } from '../src/backends/claude/text.js'
import { codexTexts } from '../src/backends/codex/text.js'
import { PLATFORM_TEXT, type PlatformTextKey } from '../src/backends/shared/platform-text.js'
import { SPINNER_VERBS } from '../src/terminal-utils/spinnerVerbs.js'

/** Dictionaries a backend carries itself (B-3, B-5), audited with the same
 *  rules minus the dead-key one (see the section at the end). */
const BACKEND_TEXT_MODULES: readonly { readonly module: string; readonly dict: Readonly<Record<string, { readonly zh?: I18nText; readonly en?: I18nText }>> }[] = [
  { module: 'src/backends/claude/text.ts', dict: claudeTexts },
  { module: 'src/backends/codex/text.ts', dict: codexTexts },
]

/** 与后端共用的平台文案真源（C-2）：宿主字典与两个内置后端都从这里展开。 */
const PLATFORM_TEXT_SOURCE = 'src/backends/shared/platform-text.ts'

// 运行时拼接的 key 前缀（新增拼接家族时在此登记，并附拼接点）：
//   cmd-desc-*    src/commands.ts        tOr(`cmd-desc-${command.name}`)
//   traj-sort-*   src/screens/TrajectoryScene.tsx  t(`traj-sort-${sort}`)
//   traj-proj-*   src/screens/TrajectoryScene.tsx  t(`traj-proj-${projection}`)
//   logo-drift-*  src/components/LogoV2.tsx        tOr(`logo-drift-${kind}`)
//   spinner-verb-* src/components/WorkingSpinner.tsx tOr(`spinner-verb-${verb}`)
//   tree-filter-* src/screens/SessionTree.tsx      t(`tree-filter-${filter}`)
//   tree-kind-*   src/screens/SessionTree.tsx      t(`tree-kind-${entry.kind}`)
//   preset-name-* / preset-desc-*   src/dsh-adapter/channel/model-actions.ts   tOr(`preset-name-${presetDisplayId(preset.id)}`) — built-in preset display text
//   companion-anim-*  src/components/sidePanel/companion/skins.tsx  tOr(`companion-anim-${kitId}-${animationKey}`) — 宠物「当前动作」行的动画名；英文按素材包身份 + 动画键取，缺键回落素材包 JSON 的中文 title
const DYNAMIC_PREFIXES = ['cmd-desc-', 'traj-sort-', 'traj-proj-', 'logo-drift-', 'spinner-verb-', 'tree-filter-', 'tree-kind-', 'preset-name-', 'preset-desc-', 'agent-message-delivery-', 'agent-message-via-', 'team-status-', 'companion-anim-']

let failures = 0
function fail(msg: string) {
  failures++
  console.error(`  ✗ ${msg}`)
}

for (const verb of SPINNER_VERBS) {
  const key = `spinner-verb-${verb.toLowerCase()}`
  if (i18nDict[key] === undefined) fail(`${key}: spinner verb 缺少中英文映射`)
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
const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src', 'scripts'], { encoding: 'utf8' })
  .split('\0'))]
  .filter(f => /\.(ts|tsx|mjs|cjs|js)$/.test(f))
  .filter(f => existsSync(f))
  // 字典文件自身不算"使用"：条目就定义在里面，否则任何死 key 都能被自己的
  // 定义救活。平台文案真源（C-2）同理——它里面的键是定义，消费点在宿主字典
  // 与两个后端（各以字面量引用，见 §6）。
  .filter(f => f !== 'src/i18n.ts' && f !== 'scripts/verify-i18n.ts' && f !== PLATFORM_TEXT_SOURCE)
let corpus = ''
for (const f of files) {
  // Worktrees may have deleted tracked files before a later commit; a missing
  // source file cannot contribute dead-key corpus and should not fail this gate.
  if (!existsSync(f)) continue
  corpus += readFileSync(f, 'utf8')
}
for (const key of Object.keys(i18nDict)) {
  if (DYNAMIC_PREFIXES.some(p => key.startsWith(p))) continue
  if (!corpus.includes(`'${key}'`) && !corpus.includes(`"${key}"`) && !corpus.includes(`\`${key}\``)) {
    fail(`${key}: 死 key——src/ 与 scripts/ 无引用（运行时拼接的 key 请登记 DYNAMIC_PREFIXES）`)
  }
}

// ── 4：英文文案字面量 tripwire（issue #980）─────────────────────────
// 整句级 UI 英文只允许活在字典里。src/（字典自身除外）出现这些字节 = 有
// 组件绕过 t() 硬编码（或注释整句引用了文案——注释请引用键名）。
// 收录标准：句级特异性（不会撞注释/标识符的完整英文句子），一次一族。
const FORBIDDEN_LITERALS = ['ctrl+o to expand', 'Killed by signal']
for (const f of files.filter(f => f.startsWith('src'))) {
  const content = readFileSync(f, 'utf8')
  for (const literal of FORBIDDEN_LITERALS) {
    if (content.includes(literal)) {
      fail(`${f}: 硬编码英文文案 "${literal}"——组件文案请走 t()（i18n.ts 字典）；注释请引用键名而非整句文案`)
    }
  }
}

// ── 4b：中文文案字面量 tripwire（issue #980 的镜像形态）───────────────
// 英文漏译在 en 界面上是一句中文，和中文漏译在 zh 界面上一模一样刺眼，但
// §4 那张手工清单只挡得住「句级英文」——中文短语文量大、撞标识符概率低，
// 逐条登记永远追不上新增。这里改成结构性判定：扫所有**上屏代码**里的字符串
// 字面量（注释剥掉，注释本来就该写中文），出现汉字即红，除非登记了理由。
//
// 结构性豁免优先：双语表的「zh 那一列」当然有汉字。字面量前面最近的属性名是
// 翻译列名（`zh`，或 `hintZh` / `descZh` 这类驼峰后缀；值可以是字符串，也可以是
// `d => \`…\`` 这种函数）就是翻译列，不是漏译。这条规则一次覆盖字典、设置项
// 定义、tips、provider 向导与启动器双语表，比逐文件登记精准得多。
const TRANSLATION_COLUMN_KEY = /^(?:zh|[A-Za-z_$][\w$]*Zh)$/

// 逐条豁免：`literal` 是该文件里必须出现的一段，`reason` 说明为什么它不是漏译。
// 新增一条要能一句话说清「这句为什么不上屏」或「为什么两种语言都该长这样」。
const HAN_ALLOWLIST: readonly { readonly file: string; readonly literal: string; readonly reason: string }[] = [
  {
    file: 'src/components/LangPicker.tsx',
    literal: '中文',
    reason: '语言自称用该语言书写（endonym）——选单里 zh 那一行在英文界面也必须写「中文」，否则用户找不到它',
  },
  {
    file: 'src/components/workspaces/HomeWorkspaceRow.tsx',
    literal: '界…',
    reason: '只进 stringWidth 做宽度预留，从不拼进上屏文本',
  },
  {
    file: 'src/settings/definitions.ts',
    literal: '中文',
    reason: '语言选项的 label 同样是 endonym（与 LangPicker 同一约定）——英文界面里 zh 那一档也写作「中文」',
  },
  {
    file: 'src/components/sidePanel/companion/skins.tsx',
    literal: '鲸娘',
    reason: '皮肤自带的中文名，留作 titleKey 缺失时的兜底；上屏优先走 companion-skin-whaleGirl（两种语言各有其文）',
  },
  {
    file: 'src/terminal-utils/cjk-emphasis.ts',
    literal: '぀-ヿ',
    reason: 'Unicode 区段正则的源码（解码后含汉字），不是文案——它喂给 new RegExp，永不上屏',
  },
]

/** `x === 'zh'` / `'zh' === x`——语言分支的判据（两种写法都认）。 */
function isZhTest(node: ts.Expression): boolean {
  if (!ts.isBinaryExpression(node)) return false
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
    && node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken) return false
  const isZh = (e: ts.Expression): boolean => ts.isStringLiteral(e) && e.text === 'zh'
  return isZh(node.left) || isZh(node.right)
}

/**
 * 一个源文件里「可能是文案」的两类字节：字符串/模板字面量的内容，以及 JSX 的
 * 子节点文本——两者都直接上屏。用 TypeScript 的 AST 而不是正则扫行：注释天然
 * 不在节点里（注释按仓库约定就该写中文），正则字面量、嵌套引号与 `${…}`
 * 都不会把扫描器带跑，属性名判定也准。
 *
 * `translationColumn` 沿树往下传：`zh: …` / `hintZh: d => \`…\`` /
 * `descriptions: { zh: … }` 里的内容是翻译列，不是漏译。
 */
function hanCandidates(fileName: string, src: string): { line: number; text: string; kind: string }[] {
  const source = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const out: { line: number; text: string; kind: string }[] = []
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const walk = (node: ts.Node, translationColumn: boolean): void => {
    let column = translationColumn
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : ''
      // 继承优先：`safeMenuLabels: { zh: { retry: '…' } }` 的翻译列在上一层，
      // 里层属性名（retry）不是翻译列名，但不能把已经成立的翻译列抹掉。
      if (TRANSLATION_COLUMN_KEY.test(name)) column = true
    }
    // 语言分支：`lang === 'zh' ? '中文…' : 'english…'` 的真分支就是中文那一侧，
    // 形态与双语表等价（启动器与若干老代码这么写），同样不是漏译。
    if (ts.isConditionalExpression(node) && isZhTest(node.condition)) {
      walk(node.condition, column)
      walk(node.whenTrue, true)
      walk(node.whenFalse, column)
      return
    }
    if (!column) {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        out.push({ line: lineOf(node), text: node.text, kind: 'string' })
      } else if (node.kind === ts.SyntaxKind.TemplateHead
        || node.kind === ts.SyntaxKind.TemplateMiddle
        || node.kind === ts.SyntaxKind.TemplateTail) {
        out.push({ line: lineOf(node), text: (node as ts.TemplateLiteralToken).text, kind: 'template' })
      } else if (ts.isJsxText(node)) {
        const text = node.text.trim()
        if (text !== '') out.push({ line: lineOf(node), text, kind: 'jsxtext' })
      }
    }
    ts.forEachChild(node, child => walk(child, column))
  }
  walk(source, false)
  return out
}

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/
const HAN_SCANNED = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src', 'bin', 'cli', 'standalone'], { encoding: 'utf8' })
  .split('\0'))]
  .filter(f => /\.(ts|tsx|mjs|cjs|js)$/.test(f))
  .filter(f => !f.startsWith('cli/test/'))
  .filter(f => existsSync(f))
for (const f of HAN_SCANNED) {
  // Worktrees may have deleted a tracked file; nothing to scan, nothing to fail.
  let content: string
  try { content = readFileSync(f, 'utf8') } catch { continue }
  for (const literal of hanCandidates(f, content)) {
    if (!HAN.test(literal.text)) continue
    const exemption = HAN_ALLOWLIST.find(e => e.file === f && literal.text.includes(e.literal))
    if (exemption !== undefined) continue
    fail(`${f}:${literal.line}: 硬编码中文文案（${literal.kind}）${JSON.stringify(literal.text.slice(0, 60))}——上屏文案请走 t()（i18n.ts 字典）；确需保留请登记 HAN_ALLOWLIST 并写明理由`)
  }
}

// ── 5：后端自带文案（B-3）───────────────────────────────────────────
// A backend writes its own copy (D2: the host dictionary is not readable from
// a backend), so the two silent-failure classes above apply there too — a
// missing `en` would show zh to an English user, and `{name}` would go on
// screen unfilled. Registered modules are audited through the read-only view
// each exports. The dead-key rule does NOT apply here: a backend's entries are
// consumed by `claudeText` / `claudeTemplate` calls inside its own package, a
// typo is already a compile error (`ClaudeTextKey`), and an unused entry is
// dead weight rather than a silent failure.
for (const { module, dict } of BACKEND_TEXT_MODULES) {
  for (const [key, entry] of Object.entries(dict)) {
    if (entry.zh === undefined) fail(`${module}: ${key}: 缺 zh`)
    if (entry.en === undefined) fail(`${module}: ${key}: 缺 en`)
    for (const lang of ['zh', 'en'] as const) {
      for (const form of forms(entry[lang])) {
        const m = singleBrace.exec(form)
        if (m) fail(`${module}: ${key}.${lang}: 单花括号 {${m[1]}}——模板只替换 {{${m[1]}}}`)
      }
    }
    const zh = placeholders(entry.zh)
    const en = placeholders(entry.en)
    if (entry.en !== undefined && !isSubset(zh, en) && !isSubset(en, zh)) {
      fail(`${module}: ${key}: 占位符名不一致 zh={{${[...zh].join(',')}}} en={{${[...en].join(',')}}}`)
    }
  }
}

// ── 6：跨字典一致性（平台文案只有一处真源）──────────────────────────────
// 宿主与内置后端渲染的是同一批平台字符串，值只写在 PLATFORM_TEXT_SOURCE 一处：
// 宿主字典 `...PLATFORM_TEXT` 展开，两个后端 `pickPlatformText([...])` 各取自己
// 渲染的那几条。这条门禁的内容就是"逐字相等"——键存在不算通过，只有值与真源
// 相等才算，所以任何一侧把一份内联副本写回来（同名键在展开之后会覆盖真源）
// 都会红。性质：防的是"副本被重新引入"，不是防键缺失（缺键由存在性检查兜住）。
const PLATFORM_TEXT_CONSUMERS: readonly {
  readonly module: string
  readonly dict: Readonly<Record<string, { readonly zh?: I18nText; readonly en?: I18nText }>>
  readonly keys: readonly PlatformTextKey[]
}[] = [
  {
    module: 'src/backends/claude/text.ts',
    dict: claudeTexts,
    keys: ['doctor-unknown', 'rewind-first-message', 'rename-failed', 'rename-usage', 'status-rate-limit-five-hour', 'status-rate-limit-seven-day'],
  },
  {
    module: 'src/backends/codex/text.ts',
    dict: codexTexts,
    keys: ['capability-failed', 'status-rate-limit-five-hour', 'status-rate-limit-seven-day', 'doctor-unknown', 'effort-invalid', 'tool-name-bash', 'tool-name-edit'],
  },
]

const platformKeys = Object.keys(PLATFORM_TEXT) as PlatformTextKey[]
for (const key of platformKeys) {
  const entry = i18nDict[key]
  if (entry === undefined) {
    fail(`i18nDict: ${key}: 平台文案没有展开——${PLATFORM_TEXT_SOURCE} 的每个键都必须出现在宿主字典里`)
    continue
  }
  for (const lang of ['zh', 'en'] as const) {
    if (entry[lang] !== PLATFORM_TEXT[key][lang]) {
      fail(`i18nDict: ${key}.${lang}: 与 ${PLATFORM_TEXT_SOURCE} 不一致（宿主字典不得另存一份副本）${JSON.stringify(entry[lang])} ≠ ${JSON.stringify(PLATFORM_TEXT[key][lang])}`)
    }
  }
}

for (const { module, dict, keys } of PLATFORM_TEXT_CONSUMERS) {
  // 登记清单必须恰好等于该后端实际携带的平台键：少一条＝展开被删（消费点
  // 悄悄没了文案），多一条＝有人把它写成内联副本、或新共用了文案，都要在这里
  // 过目后才放行。
  const carried = platformKeys.filter(key => dict[key] !== undefined).sort()
  const pinned = [...keys].sort()
  if (carried.join(' ') !== pinned.join(' ')) {
    fail(`${module}: 携带的平台键与登记清单不一致——实际 ${carried.join(',') || '（无）'}，登记 ${pinned.join(',')}`)
  }
  for (const key of keys) {
    const entry = dict[key]
    if (entry === undefined) continue // 集合比对已报过；这里只比字面值
    for (const lang of ['zh', 'en'] as const) {
      if (entry[lang] !== PLATFORM_TEXT[key][lang]) {
        fail(`${module}: ${key}.${lang}: 与 ${PLATFORM_TEXT_SOURCE} 不一致（不得另写副本）${JSON.stringify(entry[lang])} ≠ ${JSON.stringify(PLATFORM_TEXT[key][lang])}`)
      }
    }
  }
}

const total = Object.keys(i18nDict).length
const backendTotal = BACKEND_TEXT_MODULES.reduce((sum, module) => sum + Object.keys(module.dict).length, 0)
if (failures > 0) {
  console.error(`verify-i18n: ${total} 条目（+ 后端自带 ${backendTotal}），${failures} 处失败`)
  process.exit(1)
}
console.log(`✓ verify-i18n: ${total} 条目（+ 后端自带 ${backendTotal}）——语言完整、占位符一致、无死 key、平台文案跨字典一致（${Object.keys(PLATFORM_TEXT).length} 条）`)
