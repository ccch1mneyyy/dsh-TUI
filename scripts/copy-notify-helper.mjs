#!/usr/bin/env node
/**
 * copy-notify-helper.mjs — 把随包分发的 helper C# 源码搬进 tsc 的产物目录。
 *
 * 用法：
 *   node scripts/copy-notify-helper.mjs           # 复制/刷新（`compile` 串里 tsc 之后的一步）
 *   node scripts/copy-notify-helper.mjs <root>    # 指向别的树（聚焦回归用；缺省＝仓库根）
 *
 * 为什么有这一步：helper 的编译模块是 `src/ink/notify-helper/compile.ts`，tsc 把它产出到
 * `lib/types/ink/notify-helper/compile.js`，而运行期用 `new URL('./activate.cs',
 * import.meta.url)` 在**自己旁边**找 C# 源。可 `.cs` 不在 tsc 的 program 内，`package.json`
 * 的 `files` 又不含 `src/`（`verify-package.mjs` 明确拒绝 tarball 里出现 `src/`）——所以只有
 * 构建期把它放到编译模块旁边，装包后的首次跳回才找得到源，否则恒 `source-missing`。
 *
 * 幂等：字节相同即不重写（副本 mtime 只在源码真变时前进）。可判定失败：真源缺失 → 退出码 1 并
 * 说明缺的是哪个文件，绝不留半个产物。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 真源与产物，各自相对所在树的根。产物必须落在 tsc 的 outDir 里——`package.json` 的 `main`
 * 指向同一棵树，回归据此核对两者没有分家。
 */
const SOURCE = join('src', 'ink', 'notify-helper', 'activate.cs')
const PRODUCT = join('lib', 'types', 'ink', 'notify-helper', 'activate.cs')

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = process.argv[2] === undefined ? repoRoot : resolve(process.argv[2])
const source = join(root, SOURCE)
const product = join(root, PRODUCT)

if (!existsSync(source)) {
  console.error(`[notify-helper] 缺少真源 ${SOURCE}（找的是 ${source}）`)
  // 用 exitCode 而不是 process.exit()：Windows 上管道输出是异步的，立刻退出会截断消息。
  process.exitCode = 1
} else {
  const bytes = readFileSync(source)
  const existed = existsSync(product)
  if (existed && readFileSync(product).equals(bytes)) {
    console.log(`[notify-helper] 已是最新：${PRODUCT}`)
  } else {
    mkdirSync(dirname(product), { recursive: true })
    writeFileSync(product, bytes)
    console.log(`[notify-helper] ${existed ? 'update' : 'add   '} ${PRODUCT}`)
  }
}
