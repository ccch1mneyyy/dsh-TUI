import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { assertBuildableTree } from './deploy/guard.mjs'

// lib/ is exclusively generated output. Resolve it from this script instead
// of the caller's cwd so the cleanup target cannot drift outside the package.
const libDir = fileURLToPath(new URL('../lib/', import.meta.url))

// M0 同轨风险止血（deploy-transition 设计 §S04 阶段 0）：当本包根是某个
// dsh profile junction 的当前指向（live runtime tree）时，清空 lib 会在
// 活进程/重启窗口下制造 ENOENT 与混代——拒绝执行并给出隔离构建路径。
// DSH_TUI_ALLOW_LIVE_TREE_BUILD=1 是知情操作员的显式逃生口。
assertBuildableTree(join(dirname(libDir)), 'clean lib/')

rmSync(libDir, { recursive: true, force: true })
