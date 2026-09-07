#!/usr/bin/env node
/**
 * 固定 sleep 防回流门禁（issue #569，接在 verify:build 链里）。
 *
 * 扫描 scripts/run-ci-group.mjs 登记的全部脚本：每个 `sleep(` 调用点必须
 * 带 `固定窗:<类别>` 标签（类别定义见 scripts/lib/term-test.mjs 头部）。
 * 标签位置二选一：
 *   - 同行尾注释：      `await sleep(300) // 固定窗:墙钟 等 250ms 节流冷却`
 *   - 紧贴上方的注释块：`// 固定窗:探针 空提交不得发出请求` 后紧跟 sleep 行
 *     （多行注释块任一行含标签即可，块与 sleep 之间不能有空行/代码）
 *
 * `固定窗:待迁移` 是显式登记的技术债（跟踪 issue #791）：按文件计数，必须与
 * scripts/fixed-window.baseline.json 逐文件完全一致——任一文件增加即失败
 * （旧债不能抵消新债），减少则用 --write-baseline 重写基线一起提交。
 *
 * 用法：
 *   node scripts/verify-fixed-window.mjs                  # 门禁模式，全部登记脚本
 *   node scripts/verify-fixed-window.mjs a.tsx b.mjs       # 只检查指定文件（打标时自查）
 *   node scripts/verify-fixed-window.mjs --list            # 列出每个标签的现场（不判失败）
 *   node scripts/verify-fixed-window.mjs --write-baseline  # 按当前待迁移分布重写基线
 *
 * 只做文本匹配：跳过 sleep 的定义/导入行与注释行，不跳过任何调用。
 * 轮询循环里的 sleep 也要求处理——应改用 term-test 的 settle/settled。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const REGISTRY = resolve(ROOT, 'scripts/run-ci-group.mjs')
const BASELINE = resolve(ROOT, 'scripts/fixed-window.baseline.json')

const TAGS = ['探针', '墙钟', 'pacing', '待迁移']
const TAG_RE = /固定窗:([^\s,，。;；)）]+)/g
const CALL_RE = /\bsleep\s*\(/g
const DEF_RE = /(?:\b(?:const|let|var|function)\s+sleep\b|\bsleep\s*=\s*(?:\(|async|\w+\s*=>)|\bimport\b[^\n]*\bsleep\b|^\s*sleep\s*,?\s*$)/
const COMMENT_LINE_RE = /^\s*(?:\/\/|\/\*|\*)/

const argv = process.argv.slice(2)
const listMode = argv.includes('--list')
const writeBaseline = argv.includes('--write-baseline')
const explicit = argv.filter(a => !a.startsWith('--'))

function registeredScripts() {
  const src = readFileSync(REGISTRY, 'utf8')
  const found = new Set()
  for (const m of src.matchAll(/scripts\/([A-Za-z0-9_.\/-]+\.(?:mjs|tsx|ts|js))/g)) found.add(m[1])
  return [...found].sort().map(f => resolve(ROOT, 'scripts', f))
}

function tagsIn(text) {
  return [...text.matchAll(TAG_RE)].map(m => m[1])
}

/** @returns {{ line: number, tags: string[] }[]} 每个 sleep 调用点及其标签 */
function scan(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const sites = []
  let inBlock = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    // 粗粒度跳过 /* */ 块注释内部（标签也可能写在这里，但不作为调用点）
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false
      continue
    }
    if (trimmed.startsWith('/*') && !trimmed.includes('*/')) { inBlock = true; continue }
    if (COMMENT_LINE_RE.test(line)) continue
    const calls = line.match(CALL_RE)?.length ?? 0
    if (calls === 0) continue
    if (DEF_RE.test(line)) continue
    // 排除字符串/注释里的伪调用不做——出现即视为调用点，宁严勿漏。
    // 同行标签：尾部 // 或 /* */ 都算，整行扫描即可。
    const tags = tagsIn(line)
    // 上方紧贴的注释块
    let j = i - 1
    while (j >= 0 && COMMENT_LINE_RE.test(lines[j])) {
      tags.push(...tagsIn(lines[j]))
      if (lines[j].trim().startsWith('/*')) break
      j--
    }
    // 同一行多个 sleep( 调用共用该行的标签，但按调用点各记一处。
    for (let k = 0; k < calls; k++) sites.push({ line: i + 1, tags })
  }
  return sites
}

const files = explicit.length ? explicit.map(f => resolve(ROOT, f)) : registeredScripts()

const missing = []
const unknown = []
const counts = Object.fromEntries(TAGS.map(t => [t, 0]))
const byTag = Object.fromEntries(TAGS.map(t => [t, []]))
/** @type {Record<string, number>} 待迁移按文件计数（相对路径，排序后写入基线） */
const pendingByFile = {}
let total = 0

for (const file of files) {
  const rel = relative(ROOT, file).replaceAll('\\', '/')
  let sites
  try { sites = scan(file) } catch (err) {
    console.error(`verify-fixed-window: 无法读取 ${rel}: ${err.message}`)
    process.exit(1)
  }
  for (const site of sites) {
    total++
    const loc = `${rel}:${site.line}`
    if (site.tags.length === 0) { missing.push(loc); continue }
    for (const tag of site.tags) {
      if (!TAGS.includes(tag)) { unknown.push(`${loc} 固定窗:${tag}`); continue }
      counts[tag]++
      byTag[tag].push(loc)
      if (tag === '待迁移') pendingByFile[rel] = (pendingByFile[rel] ?? 0) + 1
    }
  }
}

if (listMode) {
  for (const tag of TAGS) {
    console.log(`\n固定窗:${tag} (${counts[tag]})`)
    for (const loc of byTag[tag]) console.log(`  ${loc}`)
  }
  console.log(`\n未标注 (${missing.length})`)
  for (const loc of missing) console.log(`  ${loc}`)
  process.exit(0)
}

let failed = false
if (missing.length) {
  failed = true
  console.error(`verify-fixed-window: ${missing.length} 处 sleep( 缺少 固定窗: 标签（分类见 scripts/lib/term-test.mjs 头部）：`)
  for (const loc of missing) console.error(`  ${loc}`)
}
if (unknown.length) {
  failed = true
  console.error(`verify-fixed-window: ${unknown.length} 处标签类别未知（允许：${TAGS.map(t => `固定窗:${t}`).join(' / ')}）：`)
  for (const loc of unknown) console.error(`  ${loc}`)
}

const sortedPending = Object.fromEntries(Object.keys(pendingByFile).sort().map(k => [k, pendingByFile[k]]))
const baselineRel = relative(ROOT, BASELINE)

if (writeBaseline) {
  if (explicit.length) {
    console.error('verify-fixed-window: --write-baseline 必须对全部登记脚本运行，不能带文件参数')
    process.exit(1)
  }
  writeFileSync(BASELINE, JSON.stringify(sortedPending, null, 2) + '\n')
  console.log(`verify-fixed-window: 基线已重写 ${baselineRel}（${Object.keys(sortedPending).length} 个文件，${counts['待迁移']} 处待迁移）`)
} else if (!explicit.length) {
  let baseline
  try { baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) } catch (err) {
    console.error(`verify-fixed-window: 无法读取基线 ${baselineRel}: ${err.message}`)
    process.exit(1)
  }
  const grew = []
  const shrank = []
  for (const file of new Set([...Object.keys(baseline), ...Object.keys(sortedPending)])) {
    const expected = baseline[file] ?? 0
    const actual = sortedPending[file] ?? 0
    if (actual > expected) grew.push(`${file}: 基线 ${expected} → 实际 ${actual}`)
    else if (actual < expected) shrank.push(`${file}: 基线 ${expected} → 实际 ${actual}`)
  }
  if (grew.length) {
    failed = true
    console.error('verify-fixed-window: 固定窗:待迁移 超出基线——新代码不得新增待迁移，改用 settled（旧债减少不能抵消）：')
    for (const line of grew) console.error(`  ${line}`)
    const grownFiles = new Set(grew.map(line => line.slice(0, line.indexOf(':'))))
    for (const loc of byTag['待迁移']) {
      if (grownFiles.has(loc.slice(0, loc.lastIndexOf(':')))) console.error(`    ${loc}`)
    }
  }
  if (shrank.length) {
    failed = true
    console.error(`verify-fixed-window: 固定窗:待迁移 少于基线——请运行 --write-baseline 重写 ${baselineRel} 并一起提交（跟踪 issue #791）：`)
    for (const line of shrank) console.error(`  ${line}`)
  }
}

const summary = TAGS.map(t => `${t}=${counts[t]}`).join(' ')
if (failed) {
  console.error(`verify-fixed-window: FAIL（${files.length} 个脚本，${total} 处 sleep：${summary}，未标注=${missing.length}）`)
  process.exit(1)
}
console.log(`verify-fixed-window: OK（${files.length} 个脚本，${total} 处 sleep：${summary}）`)
