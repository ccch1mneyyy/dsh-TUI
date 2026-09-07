/**
 * verify-effort-default — 默认推理强度（/settings effortDefault）纯函数回归。
 *
 * 覆盖 src/effortPrefs.ts：
 *   1. resolveEffortDefault 优先级链：settings 用户层 > cordis `effort` >
 *      持久化 /effort 选择（effort.json）> undefined（模型/适配器默认）；
 *      `auto` 由调用方折叠为 undefined 后走同一链（这里显式传入 undefined
 *      验证折叠后行为）；
 *   2. readEffortPref / writeEffortPref 的 best-effort 文件语义：写入回读、
 *      缺文件、坏 JSON、结构不符（非对象 / effort 非字符串 / 空串）均回落
 *      undefined。
 *
 * 运行：node --import tsx/esm scripts/verify-effort-default.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readEffortPref, resolveEffortDefault, writeEffortPref } from '../src/effortPrefs.js'

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  const mark = ok ? 'ok  ' : 'FAIL'
  console.log(`${mark} ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

// ── 1. 优先级链 ──────────────────────────────────────────────────────────
{
  check(
    'settings 层优先于 cordis 与 effort.json',
    resolveEffortDefault('high', 'max', 'low') === 'high',
  )
  check(
    'settings 缺省（auto）时 cordis effort 生效',
    resolveEffortDefault(undefined, 'max', 'low') === 'max',
  )
  check(
    'settings 与 cordis 都缺省时 effort.json 生效',
    resolveEffortDefault(undefined, undefined, 'low') === 'low',
  )
  check(
    '全缺省 → undefined（适配器默认）',
    resolveEffortDefault(undefined, undefined, undefined) === undefined,
  )
  check(
    '空串不与未设置混淆（写坏值也原样透传，由调用方/运行时校验）',
    resolveEffortDefault('', undefined, undefined) === '',
  )
}

// ── 2. effort.json best-effort 文件语义 ─────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-effort-default-'))
try {
  {
    check('缺文件 → undefined', readEffortPref(dir) === undefined)
  }
  {
    const wrote = writeEffortPref('max', dir)
    check('写入成功', wrote === true)
    check('回读一致', readEffortPref(dir) === 'max', readEffortPref(dir) ?? '(undefined)')
    writeEffortPref('high', dir)
    check('覆盖写入生效', readEffortPref(dir) === 'high')
  }
  {
    writeFileSync(join(dir, 'effort.json'), '{ not json', 'utf8')
    check('坏 JSON → undefined', readEffortPref(dir) === undefined)
  }
  {
    writeFileSync(join(dir, 'effort.json'), '{"effort": 3}', 'utf8')
    check('结构不符（非字符串）→ undefined', readEffortPref(dir) === undefined)
  }
  {
    writeFileSync(join(dir, 'effort.json'), '{"effort": ""}', 'utf8')
    check('空串档位 → undefined', readEffortPref(dir) === undefined)
  }
  {
    writeFileSync(join(dir, 'effort.json'), '[1,2]', 'utf8')
    check('非对象 JSON → undefined', readEffortPref(dir) === undefined)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// ── 3. resolveEffortDefault 与文件链的组合 ───────────────────────────────
const dir2 = mkdtempSync(join(tmpdir(), 'dsh-tui-effort-default2-'))
try {
  writeEffortPref('off', dir2)
  check(
    'settings 覆盖持久化 /effort',
    resolveEffortDefault('max', undefined, readEffortPref(dir2)) === 'max',
  )
  check(
    'settings auto → 回落到持久化 /effort',
    resolveEffortDefault(undefined, undefined, readEffortPref(dir2)) === 'off',
  )
  writeEffortPref('low', dir2)
  check(
    'settings auto → 跟随最近一次 /effort',
    resolveEffortDefault(undefined, 'high', readEffortPref(dir2)) === 'high',
  )
} finally {
  rmSync(dir2, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`verify-effort-default: ${failures} failure(s)`)
  process.exit(1)
}
console.log('verify-effort-default: all ok')
