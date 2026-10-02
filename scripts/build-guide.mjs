#!/usr/bin/env node
/**
 * build-guide.mjs — 把 docs/ 里面向用户的手册同步进 guide/dsh-tui-guide/。
 *
 * 用法：
 *   node scripts/build-guide.mjs          # 复制/刷新，打印每个写入的文件
 *   node scripts/build-guide.mjs --check  # 只比较：有漂移 exit 2（CI 走 verify-guide.mjs）
 *
 * 逐字节复制（副本与真源同哈希，CI 才能用 hash 门禁），并删掉技能目录里清单外的
 * `*.md` 残留。SKILL.md 是手写索引，永不触碰。清单见 scripts/guide-sources.mjs。
 */
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { GUIDE_DIR, guideDrift, guideFiles, repoRoot } from './guide-sources.mjs'

const check = process.argv.includes('--check')
const dir = join(repoRoot, GUIDE_DIR)
const { missingSource, missingCopy, differing, extra } = guideDrift(repoRoot)

if (missingSource.length > 0) {
  console.error(`[guide] docs/ 缺少真源：${missingSource.join(', ')}`)
  process.exit(1)
}

const pending = [...missingCopy, ...differing]
if (check) {
  if (pending.length > 0) {
    console.error(`[guide] 副本与 docs/ 不一致（跑 node scripts/build-guide.mjs）：${pending.join(', ')}`)
  }
  if (extra.length > 0) {
    console.error(`[guide] 技能目录里有清单外的残留：${extra.join(', ')}`)
  }
  if (pending.length > 0 || extra.length > 0) process.exit(2)
  console.log(`[guide] OK：${guideFiles().length} 个文件与 docs/ 逐字节一致`)
  process.exit(0)
}

mkdirSync(dir, { recursive: true })
for (const file of pending) {
  copyFileSync(join(repoRoot, 'docs', file), join(dir, file))
  console.log(`[guide] ${missingCopy.includes(file) ? 'add   ' : 'update'} ${GUIDE_DIR}/${file}`)
}
for (const file of extra) {
  rmSync(join(dir, file), { force: true })
  console.log(`[guide] remove ${GUIDE_DIR}/${file}`)
}
if (pending.length === 0 && extra.length === 0) {
  console.log(`[guide] 已是最新：${guideFiles().length} 个文件`)
}
