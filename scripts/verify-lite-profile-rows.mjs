#!/usr/bin/env node
/**
 * 门禁：`LITE_PROFILE_ROW_DISABLES` 的每个 `id` 必须是 `cordis.patch.yml` 里真实的
 * insert 行 id——改名后 disable 静默失效，而 `verify:patch-surface` 不会红；
 * `ENTRY_ROW_DEFAULTS` 必须与 `dsh-tui` 行的静态 config 逐项相同（入口重建该行而不读 patch）。
 *
 * 跑法：node --import tsx/esm scripts/verify-lite-profile-rows.mjs
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ENTRY_ROW_DEFAULTS, LITE_PROFILE_ROW_DISABLES, liteProfilePlan } from '../src/dsh-adapter/lite-profile.ts'

const root = resolve(import.meta.dirname, '..')
const patchPath = join(root, 'cordis.patch.yml')

/**
 * 与 verify-patch-surface.ts 的 parsePatch 同口径：只取 `insert:` 块里的 `id`。
 * `logLevel: 'silent'` 只关掉 `!!js` 标签的解析告警（本门禁不 evaluate 这些值，
 * 26 条 `Unresolved tag` 会把 CI 日志刷满），解析结果与默认档逐字节相同。
 */
function parseInsertRows(text) {
  const doc = parseYaml(text, { logLevel: 'silent' })
  if (!Array.isArray(doc)) throw new Error('patch root is not a list')
  const rows = []
  for (const item of doc) {
    if (item === null || typeof item !== 'object') continue
    if (!Array.isArray(item.insert)) continue
    for (const row of item.insert) {
      if (row !== null && typeof row === 'object' && typeof row.id === 'string') rows.push(row)
    }
  }
  return rows
}

const rows = parseInsertRows(readFileSync(patchPath, 'utf8'))
const insertIds = new Set(rows.map(row => row.id))
const failures = []

// `!!js` 项（环境映射，入口单独重建）静默解析为表达式原文，跳过。
const rowConfig = rows.find(row => row.id === 'dsh-tui')?.config ?? {}
const staticConfig = Object.fromEntries(Object.entries(rowConfig).filter(([, value]) => !(typeof value === 'string' && value.startsWith('process.env.'))))
for (const key of new Set([...Object.keys(staticConfig), ...Object.keys(ENTRY_ROW_DEFAULTS)])) {
  if (staticConfig[key] !== ENTRY_ROW_DEFAULTS[key]) failures.push(`dsh-tui row config ${key}: patch ${JSON.stringify(staticConfig[key])}, ENTRY_ROW_DEFAULTS ${JSON.stringify(ENTRY_ROW_DEFAULTS[key])}`)
}

// 无可裁时入口仍代替 dsh-tui 行：该行必须照禁，否则同进程再挂一份运行时。
const untrimmed = liteProfilePlan({ layers: [{ packageName: '@example/bundle' }] })
if (untrimmed.trimmed || untrimmed.disableRows.map(row => row.id).join() !== 'dsh-tui') failures.push(`untrimmed plan must disable exactly dsh-tui, got ${JSON.stringify(untrimmed.disableRows)}`)

if (LITE_PROFILE_ROW_DISABLES.length === 0) failures.push('LITE_PROFILE_ROW_DISABLES is empty')
const seen = new Set()
for (const id of LITE_PROFILE_ROW_DISABLES) {
  if (seen.has(id)) failures.push(`duplicate table id: ${id}`)
  seen.add(id)
  if (!insertIds.has(id)) failures.push(`${id} — not an insert id in cordis.patch.yml`)
}

if (failures.length > 0) {
  console.error(`lite-profile-rows: ${failures.length} problem(s)`)
  for (const line of failures) console.error(`  - ${line}`)
  console.error('Changed cordis.patch.yml? Update LITE_PROFILE_ROW_DISABLES / ENTRY_ROW_DEFAULTS in src/dsh-adapter/lite-profile.ts to match.')
  process.exit(1)
}
console.log(`lite-profile-rows OK (${LITE_PROFILE_ROW_DISABLES.length} rows, all present among ${insertIds.size} patch inserts)`)
