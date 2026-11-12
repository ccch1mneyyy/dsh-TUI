#!/usr/bin/env node
/**
 * copy-notify-helper.mjs — 把随包的 C# helper 源搬进编译产物目录。
 *
 * 为什么需要搬运：npm 包只含 `lib/`（`src/` 不进 tarball），而 activate.cs 要在
 * 安装态由 in-box csc 首次编译，所以它必须和 .js 产物一起落在
 * `lib/types/ink/notify-helper/`。tsc 只产出 .js，.cs 由本脚本逐字节复制。
 *
 * 用法：node scripts/copy-notify-helper.mjs
 *       `compile` 与 `compile:src` 已把它接在 tsc（及 gen-settings-json）之后。
 * 缺源时以非零退出并打印源路径——静默通过会把缺文件推迟到安装态首次点通知。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(repoRoot, 'src/ink/notify-helper/activate.cs')
const target = join(repoRoot, 'lib/types/ink/notify-helper/activate.cs')

if (!existsSync(source)) {
  console.error(`[notify-helper] 缺少真源：${source}`)
  process.exit(1)
}
mkdirSync(dirname(target), { recursive: true })
copyFileSync(source, target)
console.log(`[notify-helper] ${target} 已就位`)
