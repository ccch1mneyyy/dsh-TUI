'use strict'
/**
 * 便携包运行时缓存完整性守卫（standalone/entry.mjs 使用，测试直测本模块）。
 *
 * 红队 P-3：解压到 cacheBase（多进程可写目录）的运行时树，旧 .complete
 * 只存 bundleId 字符串——落盘后启动链上任何 JS 被篡改（恶意 npm 脚本、
 * 本机低权进程）都无感知（实测改 update.js 无感）。本模块把
 * bin→主模块两级闭包内的关键 JS 纳入哈希清单：解压完成时逐条目计算
 * sha256 写进 .complete（bundleId 行 + `<sha256>␣␣<相对路径>` 行，与
 * SHA256SUMS 同格式；条目缺失记 `-`），每次启动重新计算并全量比对——
 * 条目集合、缺失状态、任何 digest 不一致都判 not ready，由 ensureRuntime
 * 自愈重建（重新解压覆盖）。不求全树：守的是 entry.mjs 拉起的启动链，
 * 清单外文件的改动不在威胁模型内。
 *
 * 威胁模型说明：marker 与树同目录，能改树的理论上也能重写 marker——这
 * 层守卫针对的是「改文件不换 marker」的静默篡改（实测红队场景），完整
 * 的完整性保证在构建/发布链（lockfile 锁死 + SHA256SUMS 资产）。
 *
 * CommonJS：entry.mjs 经 createRequire 引入（pkg 快照可静态收集），测试
 * 脚本直接 require；解压器由调用方注入（entry.mjs 注入 node-tar，测试
 * 注入系统 tar），本模块自身零第三方依赖。
 */
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const { join } = require('node:path')

const { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } = fs

/**
 * 清单条目：相对 runtimeRoot 的 POSIX 风格路径；含 `*` 的条目在树内
 * 按单段通配展开（dsh 构建产物带 rollup hash 后缀，跨版本会变名）。
 * 覆盖 entry.mjs 启动链的两级闭包：
 *   一级：dsh 启动器 bin.js（entry.mjs 的 argv[1] 直接拉起）+ 它静态
 *        import 的主模块（dsh-app-boot）+ 三个动态 import 的模式入口
 *        （profile-boot=TUI 启动路径 / plugin=`dsh plugin update` 更新
 *        路径 / dump-config=第三分发分支）；
 *   二级：profile-boot 装配的插件宿主 cordis 与 TUI 本体（exports 主入
 *        口 index.js、红队实测点 update.js、包 bin、manifest、patch 层）。
 */
const MANIFEST_ENTRIES = [
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
  'node_modules/@deepseek-ai/dsh/lib/profile-boot-*.js',
  'node_modules/@deepseek-ai/dsh/lib/plugin-*.js',
  'node_modules/@deepseek-ai/dsh/lib/dump-config-*.js',
  'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
  'node_modules/@deepseek-ai/dsh/package.json',
  'node_modules/@deepseek-ai/cordis/lib/index.js',
  'node_modules/@deepseek-harness-tui/dsh-tui/lib/types/index.js',
  'node_modules/@deepseek-harness-tui/dsh-tui/lib/types/update.js',
  'node_modules/@deepseek-harness-tui/dsh-tui/bin/dsh-tui.js',
  'node_modules/@deepseek-harness-tui/dsh-tui/package.json',
  'node_modules/@deepseek-harness-tui/dsh-tui/cordis.patch.yml',
]

/** 单段通配展开：`a/b-*-c.js` 在 root 下匹配实际文件，排序保证稳定。 */
function expandPattern(root, pattern) {
  if (!pattern.includes('*')) return [pattern]
  const star = pattern.indexOf('*')
  const dirRel = pattern.slice(0, pattern.lastIndexOf('/', star))
  const prefix = pattern.slice(dirRel.length + 1, star)
  const suffix = pattern.slice(star + 1)
  let names
  try {
    names = readdirSync(join(root, dirRel))
  } catch {
    return []
  }
  return names
    .filter(name => name.startsWith(prefix) && name.endsWith(suffix) && name.includes('*') === false)
    .sort()
    .map(name => `${dirRel}/${name}`)
}

/**
 * 计算清单快照：每个展开条目一个 `{ path, digest }`；文件缺失/不可读
 * 记 digest `'-'`（与存在条目一样参与一致性比对——删除清单内文件同样
 * 判 not ready，而真正没有该文件的构建布局在写 marker 时也记 '-'，自洽
 * 不会死循环重建）。
 */
function computeSnapshot(root) {
  const snapshot = []
  for (const pattern of MANIFEST_ENTRIES) {
    for (const rel of expandPattern(root, pattern)) {
      let digest = '-'
      try {
        digest = createHash('sha256').update(readFileSync(join(root, rel))).digest('hex')
      } catch {
        digest = '-'
      }
      snapshot.push({ path: rel, digest })
    }
  }
  return snapshot
}

/** 渲染 .complete 文本：bundleId 行 + 每条目 `<digest>␣␣<path>` 行。 */
function renderCompleteMarker(bundleId, snapshot) {
  return `${bundleId}\n${snapshot.map(e => `${e.digest}  ${e.path}`).join('\n')}\n`
}

/**
 * 解析 .complete 文本。任何畸形（无 bundleId 行 / digest 位置非 64 位
 * hex 或 '-'）都返回 null → not ready → 重建（fail-closed）。
 */
function parseCompleteMarker(text) {
  const lines = text.split('\n')
  const bundleId = (lines[0] ?? '').trim()
  if (bundleId === '') return null
  const entries = new Map()
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue
    const match = /^([0-9a-f]{64}|-)  (\S.*)$/.exec(line)
    if (match === null) return null
    entries.set(match[2], match[1])
  }
  return { bundleId, entries }
}

/**
 * 运行时缓存是否就绪：marker 的 bundleId、条目集合、每条 digest（含
 * 缺失状态 '-'）与当前树完全一致，且 requiredPaths（entry.mjs 契约上
 * 必须存在的启动文件）都实际存在。旧格式 marker（仅 bundleId 一行）
 * 的条目集合为空 ≠ 清单展开 → not ready → 自愈重建（升级路径，无需
 * 迁移代码）。
 */
function runtimeReady({ runtimeRoot, bundleId, requiredPaths = [] }) {
  try {
    const parsed = parseCompleteMarker(readFileSync(join(runtimeRoot, '.complete'), 'utf8'))
    if (parsed === null || parsed.bundleId !== bundleId) return false
    const snapshot = computeSnapshot(runtimeRoot)
    if (snapshot.length !== parsed.entries.size) return false
    for (const entry of snapshot) {
      if (parsed.entries.get(entry.path) !== entry.digest) return false
    }
    for (const rel of requiredPaths) {
      if (!existsSync(join(runtimeRoot, rel))) return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * 确保运行时解压就绪（原 entry.mjs 逻辑整体迁入，逻辑唯一来源便于测试）：
 * not ready（含并发竞争导致的半成品）→ 在 cacheBase 下解压到临时目录
 * → 写哈希清单 marker → 原子 rename 到 runtimeRoot。
 *
 * @param {object} options
 * @param {string} options.cacheBase - 缓存根目录（如 ~/.cache/dsh-tui-standalone）
 * @param {string} options.runtimeRoot - 本次 bundle 的解压目标目录
 * @param {string} options.bundleId - bundle 标识（tui-<ver>-dsh-<ver>）
 * @param {string} options.archivePath - 内置 runtime.tar.gz 路径
 * @param {(opts: { cwd: string, file: string, preservePaths: boolean, strict: boolean }) => Promise<void>} options.extract
 *        解压器（entry.mjs 注入 node-tar 的 x()；测试注入系统 tar）
 * @param {string[]} [options.requiredPaths] - 必须存在的启动文件（相对 runtimeRoot）
 * @param {(text: string) => void} [options.log] - 进度输出（stderr）
 */
async function ensureRuntime(options) {
  const { cacheBase, runtimeRoot, bundleId, archivePath, extract, requiredPaths = [], log } = options
  const ready = () => runtimeReady({ runtimeRoot, bundleId, requiredPaths })
  if (ready()) return

  mkdirSync(cacheBase, { recursive: true })
  const temporaryRoot = join(cacheBase, `.extract-${bundleId}-${process.pid}`)
  const temporaryArchive = join(cacheBase, `.runtime-${bundleId}-${process.pid}.tar.gz`)
  rmSync(temporaryRoot, { recursive: true, force: true })
  rmSync(temporaryArchive, { force: true })
  mkdirSync(temporaryRoot, { recursive: true })

  log?.(`[dsh-tui] 首次运行，正在释放内置 DSH/TUI 运行时到 ${runtimeRoot}\n`)
  try {
    writeFileSync(temporaryArchive, readFileSync(archivePath))
    await extract({
      cwd: temporaryRoot,
      file: temporaryArchive,
      preservePaths: false,
      strict: true,
    })
    rmSync(temporaryArchive, { force: true })
    // 解压完成即对清单条目计算哈希写入 marker（P-3：此后任何清单内文件
    // 的静默篡改都会在下一次启动的 runtimeReady 比对中暴露）。
    writeFileSync(join(temporaryRoot, '.complete'), renderCompleteMarker(bundleId, computeSnapshot(temporaryRoot)))
    if (ready()) {
      // Another process installed the same bundle while we extracted.
      rmSync(temporaryRoot, { recursive: true, force: true })
      return
    }
    if (existsSync(runtimeRoot)) rmSync(runtimeRoot, { recursive: true, force: true })
    try {
      renameSync(temporaryRoot, runtimeRoot)
    } catch (error) {
      if (!ready()) throw error
      rmSync(temporaryRoot, { recursive: true, force: true })
    }
  } catch (error) {
    rmSync(temporaryArchive, { force: true })
    rmSync(temporaryRoot, { recursive: true, force: true })
    throw error
  }
}

module.exports = {
  MANIFEST_ENTRIES,
  computeSnapshot,
  renderCompleteMarker,
  parseCompleteMarker,
  runtimeReady,
  ensureRuntime,
}
