#!/usr/bin/env node
/**
 * verify-maid-portrait-precedence.ts —— 「女仆娘立绘 vs 宠物皮肤」抢占口径的跨文件文案契约。
 *
 * 为什么是门禁：这条优先级（宠物皮肤为 `deepy`/`whaleGirl` 时开屏艺术槽被吉祥物占据、
 * 「女仆娘立绘」开关**不生效**；设成 `whale` 才走原路径、立绘**生效**）要在
 * `docs/configuration{,.en}.md`、`docs/user-guide{,.en}.md`、`README{,_ZH}.md` 六个位点上
 * 表达**同一句**口径，还要在随包手册副本里逐字节跟上。任何一处漏改或句内改写都表现为
 * "文档自相矛盾"这种静默故障——读者照旧文案操作，得到的却是新行为。所以这里把六件事钉死：
 *   1. 六个位点：冻结表述 A 的**整句**在场（不再是「三块关键子串齐了」）；
 *   2. configuration 两版：`whaleGirl` 行与 `companion.skin` 行**互相点名**，且两行下方那张
 *      **三行优先级小表**在场——首列键序、**中列（艺术槽）语义**、末列（立绘开关）判定，
 *      并保证中列不承载判定词（列没有被互换）；
 *   3. configuration 两版：小表**下方**有**冻结表述 E**（`brand=claude` 例外句）；
 *   4. configuration / user-guide / README 三份文件：旧的无条件表述**不再出现**（同一张黑名单）；
 *   5. README 两版：`## ` 配置节里整句 A 在场，且带指向 `docs/configuration` 的指针；
 *   6. `guide/**` 里 configuration / user-guide 四份副本与 `docs/` 真源逐字节一致。
 *
 * 整句判据是**逐字节**的（句内折行、加空格都算改契约）；语义关键字判据比对前抽掉空白，
 * 容忍 markdown 折行。只钉整句与语义关键字，**不钉句长 / 字符数 / 出现次数**（计数不是不变量，L-025）。
 * 失败信息点名文件与缺失/多余的串。
 *
 * 运行：node --import tsx/esm scripts/verify-maid-portrait-precedence.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { guideDrift, repoRoot } from './guide-sources.mjs'

let failures = 0
let checks = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  checks++
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

/** 冻结表述 A（docs / README / user-guide 共用的那一句）：改这句 = 改契约，两处必须同步。 */
const AUTHORITATIVE = {
  en: 'While Companion skin is deepy or whaleGirl, the splash art is that mascot and the Maid-portrait toggle has no effect; set Companion skin to whale to use the maid portrait.',
  zh: '宠物皮肤为 deepy 或 whaleGirl 时，开屏（标题）艺术槽由该吉祥物占据，「女仆娘立绘」开关不生效；把宠物皮肤设为 whale 才会用女仆娘立绘。',
} as const

type Lang = keyof typeof AUTHORITATIVE

/** 旧口径串（无条件句）：出现即说明文档又回到了"立绘无条件接管"的旧说法。三份文件共用一张黑名单。 */
const STALE = {
  zh: [
    // 旧 :485 —— 把立绘说成「最优先」，与「宠物皮肤接管」直接冲突。
    '最优先',
    // 旧 :553 —— 设置速查表里「标题像素鲸鱼换成作者绘制的女仆娘」的无条件说法。
    '标题像素鲸鱼换成作者绘制的女仆娘',
  ],
  en: [
    // 旧 :523 / :600 —— "swaps the header's pixel whale"（无条件替换）。
    "swaps the header's pixel whale",
    // 旧 :523 —— "FIRST as a **real raster**"（立绘最优先）。
    'FIRST as a **real raster**',
  ],
} as const

/** 冻结表述 C 的行序：小表三行必须按这个顺序给出皮肤取值。 */
const PRECEDENCE_ROWS = ['deepy', 'whaleGirl', 'whale'] as const

/** 小表末列（女仆娘立绘开关）的「不生效 / 生效」语义关键字；英文侧接受常见译法。 */
const INACTIVE = {
  zh: /不生效/u,
  en: /\bno effect\b|\bnot (?:in )?effective?\b|\btakes no effect\b|\b(?:is |gets )?(?:ignored|overridden|disabled)\b|\bdoes not apply\b|\bnot applied\b|\boverr?ides\b/iu,
} as const
const ACTIVE = {
  zh: /(?<!不)生效/u,
  en: /\bin effect\b|\btakes effect\b|\beffective\b|\bapplied\b|\bapplies\b|\bis active\b|\bhonou?red\b/iu,
} as const

/**
 * 冻结表述 C 的**中列**（开屏（标题）艺术槽）必须携带的语义关键字，按行给出：
 * `deepy`/`whaleGirl` 行说的是「谁占着槽」⇒ 吉祥物 / mascot；`whale` 行说的是原路径 ⇒ 像素鲸鱼 / pixel whale 与立绘 / portrait。
 * 这一列是整张表的事实主体（T-FIX-01 修的正是这列的一格），不能被改反还全绿。
 */
const SLOT_COLUMN_TOKENS = {
  zh: [
    ['吉祥物'],
    ['吉祥物'],
    ['像素鲸鱼', '立绘'],
  ],
  en: [
    ['mascot'],
    ['mascot'],
    ['pixel whale', 'portrait'],
  ],
} as const

/**
 * 冻结表述 E（`brand=claude` 例外句）在三行小表**下方**的在场判据：行首锚点 + 点名 `claude` + 语义关键字。
 * 锚点按语言固定（zh「例外：」/ en `Caveat:`），语义关键字取「谁占槽」与「本表不适用」两个意思。
 */
const BRAND_CAVEAT = {
  zh: { anchor: '例外：', keywords: ['艺术槽', '不适用'] },
  en: { anchor: 'Caveat:', keywords: ['splash art slot', 'does not apply'] },
} as const

const FILES: Record<Lang, { configuration: string; userGuide: string; readme: string; readmeHeading: string; pointer: string }> = {
  zh: {
    configuration: 'docs/configuration.md',
    userGuide: 'docs/user-guide.md',
    readme: 'README_ZH.md',
    readmeHeading: '## 配置与扩展',
    pointer: 'docs/configuration.md',
  },
  en: {
    configuration: 'docs/configuration.en.md',
    userGuide: 'docs/user-guide.en.md',
    readme: 'README.md',
    readmeHeading: '## Configuration & Extensions',
    pointer: 'docs/configuration.en.md',
  },
}

const LANGUAGES: readonly Lang[] = ['zh', 'en']
const read = (file: string): string => readFileSync(join(repoRoot, file), 'utf8')
/** markdown 会把长句折行：语义关键字比对前抽掉全部空白（整句判据不抽，见 `AUTHORITATIVE` 注释）。 */
const squash = (text: string): string => text.replace(/\s+/gu, '')
const stillPresent = (text: string, fragments: readonly string[]): string[] =>
  fragments.filter(fragment => squash(text).includes(squash(fragment)))

interface TableRow {
  readonly cells: readonly string[]
  readonly line: string
}
const tableRows = (text: string): TableRow[] => text.split(/\r?\n/u).flatMap(line => {
  if (!/^\s*\|/u.test(line)) return []
  const cells = line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim())
  return [{ cells, line }]
})
/** 行首单元格里的设置键：`` `deepy`（默认） `` → `deepy`。 */
const firstCellKey = (row: TableRow): string | undefined => /^`?([A-Za-z][\w.]*)`?/u.exec(row.cells[0] ?? '')?.[1]
const isSeparator = (row: TableRow): boolean => /^\|[\s:|-]+\|$/u.test(row.line.trim())

/**
 * 找到冻结表述 C 的三行小表：表头 + 分隔行 + `deepy`/`whaleGirl`/`whale` 三行（顺序固定）。
 * 结构判据（连续三行 + 每行 ≥3 列 + 上方是真正的表头/分隔行）把它与配置大表区分开。
 */
const precedenceTable = (text: string): TableRow[] | undefined => {
  const rows = tableRows(text)
  for (let i = 2; i + 2 < rows.length; i++) {
    const block = [rows[i]!, rows[i + 1]!, rows[i + 2]!]
    if (!block.every(row => row.cells.length >= 3)) continue
    if (!block.every((row, offset) => firstCellKey(row) === PRECEDENCE_ROWS[offset])) continue
    if (!isSeparator(rows[i - 1]!) || rows[i - 2]!.cells.length < 3) continue
    return block
  }
  return undefined
}

/** 取 `## ` 节正文（到下一个 H2 为止）；节标题不在场时返回空串。 */
const section = (text: string, heading: string): string => {
  const start = text.indexOf(heading)
  if (start < 0) return ''
  const rest = text.slice(start + heading.length)
  const end = rest.search(/\n## /u)
  return end < 0 ? rest : rest.slice(0, end)
}

/**
 * 冻结表述 E 必须在三行小表**下方**：锚点行 + 点名 `claude` + 语义关键字齐备，
 * 且行号晚于小表末行。例外句按单行冻结（句内折行 = 改契约），因此只在单行里找。
 */
const brandCaveatProblems = (text: string, table: TableRow[] | undefined, lang: Lang): string[] => {
  if (table === undefined) return ['未找到三行小表，无法定位例外句']
  const spec = BRAND_CAVEAT[lang]
  const lines = text.split(/\r?\n/u)
  const tableEnd = Math.max(...table.map(row => lines.indexOf(row.line)))
  const found = lines.findIndex(line => {
    const flat = squash(line.toLowerCase())
    return flat.startsWith(squash(spec.anchor.toLowerCase()))
      && flat.includes('claude')
      && spec.keywords.every(keyword => flat.includes(squash(keyword.toLowerCase())))
  })
  if (found < 0) {
    return [`小表下方未找到例外句（须单行：锚点 ${spec.anchor} + claude + [${spec.keywords.join(' | ')}]）`]
  }
  if (found < tableEnd) return [`例外句出现在小表之前（第 ${found + 1} 行 < 表末第 ${tableEnd + 1} 行）`]
  return []
}

// --- 0. 契约自证：整句 A 与黑名单 / 取值集合自洽 -----------------------------------
const VALUES = ['deepy', 'whaleGirl', 'whale'] as const
const unnamed = LANGUAGES.flatMap(lang =>
  VALUES.filter(value => !AUTHORITATIVE[lang].includes(value)).map(value => `${lang}:${value}`))
check('[contract] frozen sentence A names every skin value (deepy/whaleGirl/whale)', unnamed.length === 0, unnamed.join(' | '))

const contradictions = LANGUAGES.flatMap(lang =>
  stillPresent(AUTHORITATIVE[lang], STALE[lang]).map(entry => `${lang}:${entry}`))
check('[contract] frozen sentence A contradicts no stale wording', contradictions.length === 0, contradictions.join(' | '))

// --- 1. configuration ×2：整句 A + 旧串不在场 + 互相点名 + 三行小表 + 例外句 E --------
for (const lang of LANGUAGES) {
  const file = FILES[lang].configuration
  const text = read(file)

  // 1.1 冻结表述 A 的**整句**逐字节在场（不是「三块关键子串齐了」）。
  check(
    `[configuration] ${file}: contains the whole authoritative sentence A verbatim`,
    text.includes(AUTHORITATIVE[lang]),
    `missing [${AUTHORITATIVE[lang]}]`,
  )

  // 1.2 旧口径串不在场（与 user-guide / README 同一张黑名单）。
  const stale = stillPresent(text, STALE[lang])
  check(`[configuration] ${file}: no stale unconditional wording`, stale.length === 0, `unexpected [${stale.join(' | ')}]`)

  // 1.3 两行互相点名。
  const rows = tableRows(text)
  const maidRow = rows.find(row => firstCellKey(row) === 'whaleGirl')
  const skinRow = rows.find(row => firstCellKey(row) === 'companion.skin')
  const crossRefs: string[] = []
  if (maidRow === undefined) crossRefs.push('未找到 `whaleGirl` 行')
  else if (!maidRow.line.includes('companion.skin')) crossRefs.push('`whaleGirl` 行未点名 `companion.skin`')
  if (skinRow === undefined) crossRefs.push('未找到 `companion.skin` 行')
  else if (!skinRow.line.includes('whaleGirl')) crossRefs.push('`companion.skin` 行未点名 `whaleGirl`')
  check(`[configuration] ${file}: whaleGirl row and companion.skin row name each other`, crossRefs.length === 0, crossRefs.join(' | '))

  // 1.4 三行小表：结构 + 首列键序 + 中列（艺术槽）语义 + 末列（立绘开关）判定 + 列不互换。
  const table = precedenceTable(text)
  const tableProblems: string[] = []
  const middleProblems: string[] = []
  const swapProblems: string[] = []
  if (table === undefined) {
    const missingTable = '未找到三行优先级小表（表头 + 分隔行 + `deepy`/`whaleGirl`/`whale` 三行，顺序固定）'
    tableProblems.push(missingTable)
    middleProblems.push(missingTable)
    swapProblems.push(missingTable)
  } else {
    for (const [offset, row] of table.entries()) {
      const key = PRECEDENCE_ROWS[offset]!
      // 冻结表述 C 的小表是 3 列（键 / 开屏艺术槽 / 立绘开关）：中列 = `cells[1]`，判定词只认末列。
      const middle = row.cells[1] ?? ''
      const verdict = row.cells.at(-1) ?? ''
      if (offset < 2 && !INACTIVE[lang].test(verdict)) {
        tableProblems.push(`\`${key}\` 行末列缺「不生效」判定（实为 ${JSON.stringify(verdict)}）`)
      }
      if (offset === 2 && (!ACTIVE[lang].test(verdict) || INACTIVE[lang].test(verdict))) {
        tableProblems.push(`\`${key}\` 行末列缺「生效」判定（实为 ${JSON.stringify(verdict)}）`)
      }
      const absentTokens = SLOT_COLUMN_TOKENS[lang][offset]!.filter(token => !squash(middle.toLowerCase()).includes(squash(token.toLowerCase())))
      if (absentTokens.length > 0) {
        middleProblems.push(`\`${key}\` 行中列（艺术槽）缺 [${absentTokens.join(' | ')}]（实为 ${JSON.stringify(middle)}）`)
      }
      if (INACTIVE[lang].test(middle) || ACTIVE[lang].test(middle)) {
        swapProblems.push(`\`${key}\` 行中列出现「生效 / 不生效」判定词（实为 ${JSON.stringify(middle)}）——判定词只允许在末列`)
      }
    }
  }
  check(`[configuration] ${file}: 3-row precedence table (deepy/whaleGirl/whale → portrait toggle verdict)`, tableProblems.length === 0, tableProblems.join(' | '))
  check(`[configuration] ${file}: 3-row precedence table middle column keeps the splash-slot semantics`, middleProblems.length === 0, middleProblems.join(' | '))
  check(`[configuration] ${file}: 3-row precedence table keeps the verdict in the last column (columns not swapped)`, swapProblems.length === 0, swapProblems.join(' | '))

  // 1.5 冻结表述 E：`brand=claude` 例外句必须在三行小表下方。
  const caveat = brandCaveatProblems(text, table, lang)
  check(`[configuration] ${file}: states the brand=claude caveat (frozen sentence E) below the 3-row table`, caveat.length === 0, caveat.join(' | '))
}

// --- 2. user-guide ×2：整句 A 逐字节在场 + 旧口径串不在场 ---------------------------
for (const lang of LANGUAGES) {
  const file = FILES[lang].userGuide
  const text = read(file)
  check(
    `[user-guide] ${file}: contains the whole authoritative sentence A verbatim`,
    text.includes(AUTHORITATIVE[lang]),
    `missing [${AUTHORITATIVE[lang]}]`,
  )

  const stale = stillPresent(text, STALE[lang])
  check(`[user-guide] ${file}: no stale unconditional wording`, stale.length === 0, `unexpected [${stale.join(' | ')}]`)
}

// --- 3. README ×2：配置节里整句 A + 指向 docs/configuration 的指针 + 旧串不在场 -----
for (const lang of LANGUAGES) {
  const file = FILES[lang].readme
  const text = read(file)
  const body = section(text, FILES[lang].readmeHeading)
  const problems: string[] = []
  if (body === '') {
    problems.push(`未找到节标题 ${FILES[lang].readmeHeading}`)
  } else {
    if (!body.includes(AUTHORITATIVE[lang])) problems.push(`缺少整句 A（逐字节）[${AUTHORITATIVE[lang]}]`)
    if (!squash(body).includes(squash(FILES[lang].pointer))) problems.push(`缺少指向 ${FILES[lang].pointer} 的指针`)
  }
  check(`[README] ${file}: ${FILES[lang].readmeHeading} pins the whole sentence A and points at docs/configuration`, problems.length === 0, problems.join(' | '))

  const stale = stillPresent(text, STALE[lang])
  check(`[README] ${file}: no stale unconditional wording`, stale.length === 0, `unexpected [${stale.join(' | ')}]`)
}

// --- 4. guide 副本：configuration / user-guide 四份与真源逐字节一致 ----------------
const BUNDLED = ['configuration.md', 'configuration.en.md', 'user-guide.md', 'user-guide.en.md']
const drift = guideDrift(repoRoot)
const pick = (files: readonly string[]): string[] => files.filter(name => BUNDLED.includes(name))
const driftProblems = [
  `missing source [${pick(drift.missingSource).join(', ')}]`,
  `missing copy [${pick(drift.missingCopy).join(', ')}]`,
  `differing [${pick(drift.differing).join(', ')}]`,
].filter(entry => !entry.endsWith('[]'))
check('[guide] configuration/user-guide copies match docs/ byte-for-byte', driftProblems.length === 0, driftProblems.join(' '))

console.log(failures === 0 ? `\nALL PASS (${checks} checks)` : `\n${failures} FAILED of ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
