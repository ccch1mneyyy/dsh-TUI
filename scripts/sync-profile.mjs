#!/usr/bin/env node
/**
 * sync-profile.mjs — 把当前工作区产物同步到活动 dsh-tui profile，让
 * `dsh-tui` 直接跑的就是本仓库这份代码（改完即测）。
 *
 * 同步范围 = package.json `files` 列表（bin/、lib/、cordis.patch.yml、
 * dsh-ecosystem-spec/{registry,protocols,schemas}、presets、skills），
 * 与发布包完全一致。逐文件比较 hash，只复制有差异的文件；不删除 profile
 * 里多余的依赖文件（node_modules 等由 dsh plugin 管理）。
 *
 * 用法：
 *   node scripts/sync-profile.mjs            # 对比并同步（打印变更清单）
 *   node scripts/sync-profile.mjs --check    # 只对比，不改动（退出码 2 = 有差异）
 *
 * profile 定位：$DSH_HOME/profiles/dsh-tui（未设置时按平台默认：
 *   Windows %USERPROFILE%/.dsh-cc，其它 ~/.dsh）——与 bin/dsh-tui.js 一致。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const PACKAGE = '@deepseek-harness-tui/dsh-tui'
const PROFILE = 'dsh-tui'

const checkOnly = process.argv.includes('--check')

function sha256(file) {
  const hash = createHash('sha256')
  hash.update(readFileSync(file))
  return hash.digest('hex')
}

/** 收集 files 条目下的全部相对文件路径。 */
function collectFiles(entry, base, out = []) {
  const full = join(base, entry)
  if (!existsSync(full)) return out
  if (statSync(full).isFile()) {
    out.push(entry)
    return out
  }
  for (const child of readdirSync(full)) {
    collectFiles(join(entry, child), base, out)
  }
  return out
}

const dshHome = process.env.DSH_HOME
  ? resolve(process.env.DSH_HOME)
  : process.platform === 'win32'
    ? join(process.env.USERPROFILE ?? homedir(), '.dsh-cc')
    : join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', PROFILE)
const installed = join(profileDir, 'node_modules', PACKAGE)

if (!existsSync(join(installed, 'package.json'))) {
  console.error(`[sync-profile] profile 未安装：${installed}`)
  console.error(`  （首次请先运行 dsh-tui 让它自举，或手工：`)
  console.error(`   dsh plugin --profile ${PROFILE} add ${PACKAGE}@${pkg.version}）`)
  process.exit(1)
}

const profileVersion = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version
if (profileVersion !== pkg.version) {
  console.log(`[sync-profile] 版本不一致：worktree=${pkg.version} profile=${profileVersion}（文件仍按 worktree 同步；launcher 会打印对齐提示）`)
}

const rels = (pkg.files ?? []).flatMap(entry => collectFiles(entry, root))
// package.json 不在 files 里，但版本号必须跟随 worktree——否则 launcher
// 每次启动都打印 profile 对齐提示（profile 旧于启动器）。
if (!rels.includes('package.json')) rels.push('package.json')
const changed = []
for (const rel of rels) {
  const src = join(root, rel)
  const dst = join(installed, rel)
  const same = existsSync(dst) && sha256(src) === sha256(dst)
  if (!same) changed.push(rel)
}

console.log(`[sync-profile] ${PACKAGE}@${pkg.version}`)
console.log(`[sync-profile] worktree: ${root}`)
console.log(`[sync-profile] profile:  ${installed}`)
console.log(`[sync-profile] 对比 ${rels.length} 个发布文件，${changed.length} 个有差异`)

if (changed.length === 0) {
  console.log('[sync-profile] profile 已与 worktree 一致 ✅')
  process.exit(0)
}

if (checkOnly) {
  for (const rel of changed) console.log(`  ! ${rel}`)
  console.error('[sync-profile] 存在差异（--check）')
  process.exit(2)
}

for (const rel of changed) {
  const src = join(root, rel)
  const dst = join(installed, rel)
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
  console.log(`  → ${rel}`)
}
console.log('[sync-profile] 同步完成。重启 dsh-tui 即可生效。')
