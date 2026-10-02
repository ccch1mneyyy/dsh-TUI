#!/usr/bin/env node
/**
 * verify-sync-profile.mjs — sync-profile.mjs 不许写穿硬链接，无需构建、无需依赖。
 *
 * 为什么是门禁：`sync-profile.mjs` 把 worktree 的发布文件复制进已安装的包，而
 * pnpm 的 `node_modules` 是**硬链接**到内容寻址 store 的——同一个 inode 会被多个
 * 路径共享（同内容的多个文件，以及 store 条目自身）。`fs.copyFileSync` 覆盖一个
 * 已存在的文件是**就地写**，会写穿这个共享 inode：目标文件看起来对了，但同 inode
 * 的每个兄弟都被改成了新内容。实测代价是一次同步写坏 515 个 store 条目与 profile
 * 内 528 个文件，其中 `lib/types/ink/cursor.js` 变成了另一个模块的内容、去
 * re-export 一个并不存在的 `./panels.js`，TUI 启动即模块解析失败。
 *
 * 这里用一个真的硬链接对把契约定死：同步可以更新目标文件，但**绝不能**碰到同 inode
 * 的兄弟。就地 copyFileSync 的实现在这里必红。
 *
 * 运行：node scripts/verify-sync-profile.mjs
 */
import { spawnSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const syncScript = join(repoRoot, 'scripts', 'sync-profile.mjs')
// 在 package.json 的 files 清单里，且是仓内源文件——不依赖 lib/ 是否已构建。
const FIXTURE = 'cordis.yml'
const SENTINEL = 'the sibling of this inode must survive the sync\n'

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

const runSync = (...args) =>
  spawnSync(process.execPath, [syncScript, ...args], { cwd: repoRoot, encoding: 'utf8' })

const source = join(repoRoot, FIXTURE)
const sourceBytes = readFileSync(source)
const root = mkdtempSync(join(tmpdir(), 'dsh-tui-sync-profile-'))

try {
  const installed = join(root, 'installed')
  const sibling = join(root, 'store-entry')
  const target = join(installed, FIXTURE)
  mkdirSync(installed, { recursive: true })
  // 目标目录必须像一个已安装的包：脚本先读它的 package.json。
  writeFileSync(join(installed, 'package.json'), `${JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '0.0.0' })}\n`)
  // 一个"store 条目"：目标文件与它共享同一个 inode。
  writeFileSync(sibling, SENTINEL)
  linkSync(sibling, target)

  const before = statSync(target)
  check('fixture: target shares one inode with its sibling', before.nlink === 2 && before.ino === statSync(sibling).ino,
    `nlink=${before.nlink}`)

  const sync = runSync('--target', installed)
  check('sync exits 0', sync.status === 0, (sync.stderr ?? '').trim())
  check('sibling still holds its own bytes', readFileSync(sibling, 'utf8') === SENTINEL,
    JSON.stringify(readFileSync(sibling, 'utf8').slice(0, 60)))
  check('target was actually updated', readFileSync(target).equals(sourceBytes))
  check('target no longer shares the inode', statSync(target).nlink === 1, `nlink=${statSync(target).nlink}`)

  const recheck = runSync('--target', installed, '--check')
  check('--check reports no drift afterwards', recheck.status === 0, (recheck.stderr ?? '').trim())
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
