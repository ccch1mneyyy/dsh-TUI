#!/usr/bin/env node
/**
 * sync-profile.mjs — 把当前工作区产物同步到已安装的 dsh-tui 包。
 *
 * 同步范围 = package.json `files` 列表（bin/、lib/、assets/、cordis*.yml、
 * tui-profile/{registry,protocols,schemas}、presets、guide），与发布包
 * 完全一致（guide/ 是随包用户手册，见 scripts/build-guide.mjs）。逐文件比较
 * hash，只复制有差异的文件；不删除 profile
 * 里多余的依赖文件（node_modules 等由 dsh plugin 管理）。
 *
 * 写入方式：先删目标再复制，绝不就地覆盖。pnpm 的 node_modules 是硬链接到
 * 内容寻址 store 的，同一个 inode 被多个路径共享（同内容的多个文件、以及
 * store 条目本身）；`fs.copyFileSync` 覆盖已存在的文件是就地写，会**写穿**
 * 共享 inode，把兄弟文件一起改掉。删掉目标只摘掉这一个目录项，复制落到新
 * inode 上。回归见 scripts/verify-sync-profile.mjs。
 *
 * 用法：
 *   node scripts/sync-profile.mjs                   # 同步 profile 内的包
 *   node scripts/sync-profile.mjs --target <目录>   # 同步指定的安装包
 *   node scripts/sync-profile.mjs --check           # 只对比，不改动（退出码 2 = 有差异）
 *
 * profile 定位：$DSH_HOME/profiles/dsh-tui（未设置时按上游默认 ~/.dsh）。
 * DSH 优先从自己的安装目录解析同名 bundle；全局安装了 dsh-tui 时，
 * profile 内的副本不会生效。用 `dsh --profile dsh-tui --dump-config`
 * 确认实际 bundle，再通过 --target 同步那份安装包。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const PACKAGE = '@deepseek-harness-tui/dsh-tui'
const PROFILE = 'dsh-tui'

const checkOnly = process.argv.includes('--check')
const targetIndex = process.argv.indexOf('--target')
const target = targetIndex < 0 ? undefined : process.argv[targetIndex + 1]
if (targetIndex >= 0 && (target === undefined || target.startsWith('--'))) {
  throw new Error('--target needs an installed package directory')
}

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
  : join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', PROFILE)
const installed = target === undefined ? join(profileDir, 'node_modules', PACKAGE) : resolve(target)

if (!existsSync(join(installed, 'package.json'))) {
  console.error(`[sync-profile] 目标包未安装：${installed}`)
  console.error(`  profile 安装可运行 dsh plugin --profile ${PROFILE} add ${PACKAGE}@${pkg.version}`)
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
console.log(`[sync-profile] target:   ${installed}`)
console.log(`[sync-profile] 对比 ${rels.length} 个发布文件，${changed.length} 个有差异`)

if (changed.length === 0) {
  console.log('[sync-profile] 目标包已与 worktree 一致 ✅')
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
  // 摘掉这一个目录项再复制：就地覆盖会写穿共享 inode（pnpm 硬链接），
  // 把同 inode 的兄弟文件和 store 条目一起改掉。
  rmSync(dst, { force: true })
  copyFileSync(src, dst)
  console.log(`  → ${rel}`)
}
console.log('[sync-profile] 同步完成。重启 dsh-tui 即可生效。')
