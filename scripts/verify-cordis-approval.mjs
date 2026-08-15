#!/usr/bin/env node
/**
 * verify-cordis-approval.mjs — 审批服务配置回归（issue #49 尾巴）。
 *
 * 覆盖裸组合 cordis.yml 与 profile cordis.patch.yml 两个启动入口的
 * approval 配置一致性：
 *   - 裸组合必须挂载 @deepseek-ai/dsh-user-approval 行（缺了它，
 *     approval/request waterfall 无服务可答，sandbox_permissions 升级
 *     fail-closed 成 unavailable —— #49 在开发路径的复现根因）
 *   - 两个入口的 policy 表达式逐场景同值（入口语义不漂移）：
 *       linux + 默认（workspace-write）      → 'ask'
 *       linux + DSH_PERMISSION_MODE 全放行    → 'never'（无需再问）
 *       win32                                 → 'never'（无沙箱，终端信任模型）
 *
 * 不引入 YAML 解析依赖：按本仓库自述的固定行布局提取 !!js 表达式文本，
 * 用 mock process（platform/env）求值。布局变动导致提取失败时 FAIL 而非
 * 静默跳过——这正是要守的回归。
 *
 * 运行：node scripts/verify-cordis-approval.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

/** Extract the `policy: !!js "..."` expression text from an approval row. */
function extractPolicy(text, withName) {
  const pattern = withName
    ? /- id: approval\n\s+name: '@deepseek-ai\/dsh-user-approval'\n\s+config:\n\s+policy: !!js "([^"\n]+)"/
    : /- id: approval\n\s+config:\n\s+policy: !!js "([^"\n]+)"/
  return pattern.exec(text)?.[1]
}

/** Evaluate a !!js policy expression against a mocked process. */
function evalPolicy(expr, platform, permissionMode) {
  const process = { platform, env: permissionMode === undefined ? {} : { DSH_PERMISSION_MODE: permissionMode } }
  return new Function('process', `return (${expr})`)(process)
}

const SCENARIOS = [
  ['linux default (workspace-write)', 'linux', undefined, 'ask'],
  ['linux danger-full-access', 'linux', 'danger-full-access', 'never'],
  ['win32 default', 'win32', undefined, 'never'],
  ['win32 danger-full-access', 'win32', 'danger-full-access', 'never'],
]

const bare = readFileSync(join(root, 'cordis.yml'), 'utf8')
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')

const barePolicy = extractPolicy(bare, true)
check('bare cordis.yml mounts the @deepseek-ai/dsh-user-approval row', barePolicy !== undefined)
const patchPolicy = extractPolicy(patch, false)
check('profile cordis.patch.yml keeps an approval policy row', patchPolicy !== undefined)

for (const [name, platform, mode, expected] of SCENARIOS) {
  if (barePolicy !== undefined) {
    const got = evalPolicy(barePolicy, platform, mode)
    check(`bare policy: ${name} -> ${expected}`, got === expected, `got ${got}`)
  }
  if (patchPolicy !== undefined) {
    const got = evalPolicy(patchPolicy, platform, mode)
    check(`profile policy: ${name} -> ${expected}`, got === expected, `got ${got}`)
  }
}

if (barePolicy !== undefined && patchPolicy !== undefined) {
  const drift = SCENARIOS.filter(([, platform, mode]) =>
    evalPolicy(barePolicy, platform, mode) !== evalPolicy(patchPolicy, platform, mode))
  check('bare and profile policies agree in every scenario', drift.length === 0,
    drift.map(([name]) => name).join(', '))
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all approval config checks passed')
