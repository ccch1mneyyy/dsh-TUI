/**
 * 便携包运行时缓存完整性守卫回归（standalone/cacheGuard.cjs + entry.mjs）。
 *
 * 缓存清单扩容（红队 P-3）：旧 .complete 只存 bundleId 字符串，解压落
 * 盘后的启动链 JS 被篡改无感知（红队实测改 update.js 无感）——缓存是
 * 多进程可写目录，恶意 npm 脚本/本机低权进程都能改。断言：
 *  - ensureRuntime 首跑：解压 + 写哈希清单 marker + ready；
 *  - 篡改清单内的非入口 JS（update.js）→ not ready → 自愈重建恢复；
 *  - 删除清单内文件 → not ready（条目集合/缺失状态不一致）→ 重建恢复；
 *  - 旧格式 marker（仅 bundleId 一行）→ not ready 自愈重建（升级路径，
 *    无需迁移代码）；
 *  - 清单外文件被篡改 → 仍 ready（「两级闭包、不求全树」的边界确认）。
 *
 * cacheBase 收紧限定自建层级（CodeRabbit Moderate 修订）：无差别把
 * cacheBase chmod 0700 会侵入用户指定的目录——缓存指到共享盘（NFS/
 * 团队盘）时破坏他人访问。断言：预存 0755 的 cacheBase（ready 短路
 * 与冷装两条路径）保持 0755（预存目录的权限属用户决策）；自建
 * cacheBase（冷启动 mkdir）仍收紧 0700；版本子目录 tui-<v>-dsh-<v>
 * （一定由守卫创建）同样 0700。
 *
 * Run: node scripts/verify-standalone-cache-guard.mjs
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

let failures = 0
function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${name}${detail === '' ? '' : `  (${detail})`}`)
  if (!condition) failures += 1
}

const require = createRequire(import.meta.url)
const cacheGuard = require('../standalone/cacheGuard.cjs')

check('cacheGuard.cjs 可加载且导出清单/ensureRuntime/runtimeReady',
  typeof cacheGuard.MANIFEST_ENTRIES === 'object' && Array.isArray(cacheGuard.MANIFEST_ENTRIES)
    && cacheGuard.MANIFEST_ENTRIES.length >= 8
    && typeof cacheGuard.ensureRuntime === 'function'
    && typeof cacheGuard.runtimeReady === 'function',
  `entries=${cacheGuard.MANIFEST_ENTRIES?.length}`)

const { MANIFEST_ENTRIES, ensureRuntime, runtimeReady } = cacheGuard

// ─── fixture：按清单造一个 mini runtime 树，打成 runtime.tar.gz ───
// 通配条目（profile-boot-*.js 等）落地为带假 hash 后缀的具体文件；具名
// 条目逐个写入。内容任意但稳定（哈希基准 = 首次解压的树本身）。
const scratch = mkdtempSync(join(tmpdir(), 'verify-cache-guard-'))
const BUNDLE_ID = 'tui-9.9.9-dsh-9.9.9'
const srcRoot = join(scratch, 'archive-src')

function materializePattern(pattern) {
  if (!pattern.includes('*')) {
    const full = join(srcRoot, pattern)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, `content of ${pattern}\n`)
    return
  }
  const starIdx = pattern.indexOf('*')
  const prefix = pattern.slice(0, starIdx)
  const suffix = pattern.slice(starIdx + 1)
  const full = `${join(srcRoot, prefix)}fakeh4sh${suffix}`
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, `content of ${pattern}\n`)
}
for (const pattern of MANIFEST_ENTRIES) materializePattern(pattern)
// 清单外的旁路文件（边界确认用）
mkdirSync(join(srcRoot, 'node_modules', 'other-pkg'), { recursive: true })
writeFileSync(join(srcRoot, 'node_modules', 'other-pkg', 'side.js'), 'innocent\n')

const archivePath = join(scratch, 'runtime.tar.gz')
execFileSync('tar', ['-czf', archivePath, '-C', srcRoot, 'node_modules'])

// 与 entry.mjs 同款的解压注入（系统 tar，语义等价 node-tar 的 cwd/file）
const extract = options => execFileSync('tar', ['-xzf', options.file, '-C', options.cwd], { stdio: 'ignore' })
const dshBinRel = 'node_modules/@deepseek-ai/dsh/lib/bin.js'
const patchRel = 'node_modules/@deepseek-harness-tui/dsh-tui/cordis.patch.yml'

function makeEnv(name) {
  const cacheBase = join(scratch, `cache-${name}`)
  return {
    cacheBase,
    runtimeRoot: join(cacheBase, BUNDLE_ID),
    bundleId: BUNDLE_ID,
    archivePath,
    extract,
    requiredPaths: [dshBinRel, patchRel],
  }
}

const readyOf = env => runtimeReady({ runtimeRoot: env.runtimeRoot, bundleId: env.bundleId, requiredPaths: env.requiredPaths })

async function scenario(name, fn) {
  const env = makeEnv(name)
  await ensureRuntime(env)
  await fn(env)
  try { rmSync(env.cacheBase, { recursive: true, force: true }) } catch { /* best effort */ }
}

// ═══════════════ P-3：清单校验与自愈 ═══════════════

await scenario('happy', async env => {
  check('首跑后 runtimeReady 为 true', readyOf(env))
  const marker = readFileSync(join(env.runtimeRoot, '.complete'), 'utf8')
  check('marker 首行是 bundleId', marker.split('\n')[0] === BUNDLE_ID, marker.split('\n')[0])
  const digestLines = marker.split('\n').slice(1).filter(line => line !== '')
  check(
    'marker 为每个清单条目登记 sha256（含通配展开与 update.js）',
    digestLines.length >= MANIFEST_ENTRIES.length && digestLines.some(line => line.endsWith('lib/types/update.js')),
    `lines=${digestLines.length}`,
  )
})

await scenario('tamper', async env => {
  // 篡改清单内非入口 JS（红队 P-3 场景：改 update.js）
  const victim = join(env.runtimeRoot, 'node_modules/@deepseek-harness-tui/dsh-tui/lib/types/update.js')
  writeFileSync(victim, 'evil payload\n')
  check('篡改清单内非入口 JS 后 runtimeReady 为 false', !readyOf(env))
  await ensureRuntime(env)
  check('再次 ensureRuntime 自愈重建（update.js 恢复）', readFileSync(victim, 'utf8') === 'content of node_modules/@deepseek-harness-tui/dsh-tui/lib/types/update.js\n')
  check('重建后 ready', readyOf(env))
})

await scenario('delete', async env => {
  // 删除清单内文件：条目缺失状态与 marker 不一致
  const victim = join(env.runtimeRoot, 'node_modules/@deepseek-ai/cordis/lib/index.js')
  rmSync(victim)
  check('删除清单内文件后 runtimeReady 为 false', !readyOf(env))
  await ensureRuntime(env)
  check('自愈重建恢复被删文件', readFileSync(victim, 'utf8') === 'content of node_modules/@deepseek-ai/cordis/lib/index.js\n')
})

await scenario('legacy-marker', async env => {
  // 旧格式 marker（仅 bundleId 一行）：条目集合不一致 → not ready 自愈重建
  writeFileSync(join(env.runtimeRoot, '.complete'), `${BUNDLE_ID}\n`)
  check('旧格式 marker（仅 bundleId）判定 not ready', !readyOf(env))
  await ensureRuntime(env)
  const marker = readFileSync(join(env.runtimeRoot, '.complete'), 'utf8')
  check('旧格式自愈重建为带哈希清单的新 marker', marker.split('\n').length > 3 && readyOf(env))
})

await scenario('out-of-manifest', async env => {
  // 清单外文件被篡改：两级闭包不求全树，仍 ready（边界确认，非漏洞——
  // 清单覆盖的是 bin→主模块启动链）
  const bystander = join(env.runtimeRoot, 'node_modules/other-pkg/side.js')
  writeFileSync(bystander, 'tampered but not guarded\n')
  check('清单外文件被篡改不触发 not ready（边界确认）', readyOf(env))
})

// ═══════════════ P-7（修订）：chmod 收紧限定自建层级 ═══════════════

await scenario('perm-ready-path', async env => {
  // ready 短路路径：预置 0755 + 已 ready 的缓存 → 预存目录权限保持用户
  // 决策（共享缓存指向 NFS/团队盘时，无差别 0700 会破坏他人访问）。
  await ensureRuntime(env)
  chmodSync(env.cacheBase, 0o755)
  check('预置 0755 后确实是非 0700（fixture 有效性）', (statSync(env.cacheBase).mode & 0o777) === 0o755)
  await ensureRuntime(env)
  check(
    'ready 短路路径的 ensureRuntime 不改写预存 cacheBase 权限（保持 0755）',
    (statSync(env.cacheBase).mode & 0o777) === 0o755,
    `mode=${(statSync(env.cacheBase).mode & 0o777).toString(8)}`,
  )
})

{
  // 预存 cacheBase + 首次冷装（not ready → 解压重建）：预存根目录同样
  // 不改写；版本子目录 tui-<v>-dsh-<v> 一定由守卫创建，仍收紧 0700。
  const env = makeEnv('perm-warm-install')
  mkdirSync(env.cacheBase, { recursive: true })
  chmodSync(env.cacheBase, 0o755)
  await ensureRuntime(env)
  check('预存 cacheBase 首次冷装后保持 0755', (statSync(env.cacheBase).mode & 0o777) === 0o755,
    `mode=${(statSync(env.cacheBase).mode & 0o777).toString(8)}`)
  check(
    '预存 cacheBase 冷装后版本子目录 tui-<v>-dsh-<v> 收紧为 0700',
    (statSync(env.runtimeRoot).mode & 0o777) === 0o700,
    `mode=${(statSync(env.runtimeRoot).mode & 0o777).toString(8)}`,
  )
  try { rmSync(env.cacheBase, { recursive: true, force: true }) } catch { /* best effort */ }
}

{
  // 冷路径（首次创建）：自建的根目录与版本子目录都收紧。
  const env = makeEnv('perm-cold')
  await ensureRuntime(env)
  check('冷路径创建的 cacheBase 同样是 0700', (statSync(env.cacheBase).mode & 0o777) === 0o700,
    `mode=${(statSync(env.cacheBase).mode & 0o777).toString(8)}`)
  check('冷路径的版本子目录 tui-<v>-dsh-<v> 是 0700', (statSync(env.runtimeRoot).mode & 0o777) === 0o700,
    `mode=${(statSync(env.runtimeRoot).mode & 0o777).toString(8)}`)
  try { rmSync(env.cacheBase, { recursive: true, force: true }) } catch { /* best effort */ }
}

// entry.mjs 集成确认：不再自带独立的 runtimeReady/ensureRuntime 定义，
// 改为 require cacheGuard（同一份守卫逻辑，测试直接覆盖它）。
{
  const entry = readFileSync(new URL('../standalone/entry.mjs', import.meta.url), 'utf8')
  check('entry.mjs require 了 cacheGuard.cjs', /require\('\.\/cacheGuard\.cjs'\)/.test(entry))
  check(
    'entry.mjs 不再内联定义 ensureRuntime（逻辑唯一来源 cacheGuard）',
    !/function ensureRuntime\b/.test(entry.split("require('./cacheGuard.cjs')").pop()),
  )
  check(
    '清单登记 update.js / cordis / dsh-app-boot / TUI lib 入口（P-3 扩容点）',
    MANIFEST_ENTRIES.some(e => e.endsWith('lib/types/update.js'))
      && MANIFEST_ENTRIES.some(e => e.endsWith('cordis/lib/index.js'))
      && MANIFEST_ENTRIES.some(e => e.endsWith('dsh-app-boot/lib/index.js'))
      && MANIFEST_ENTRIES.some(e => e.endsWith('dsh-tui/lib/types/index.js')),
    JSON.stringify(MANIFEST_ENTRIES),
  )
}

try { rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ }
try { readdirSync(scratch) } catch { /* cleaned */ }

if (failures > 0) {
  console.error(`\nverify-standalone-cache-guard: ${failures} 个断言失败`)
  process.exit(1)
}
console.log('\nverify-standalone-cache-guard: 全部断言通过')
