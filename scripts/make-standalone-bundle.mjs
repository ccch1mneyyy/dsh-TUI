#!/usr/bin/env node
/**
 * 生成 dsh-TUI 便携包（Standalone Single Executable Bundles）。
 *
 * 用法：
 *   node scripts/make-standalone-bundle.mjs [--out <dir>] [--targets <targets>]
 *
 * 产物：<out>/ 目录下各平台的压缩包：
 *   - dsh-tui-standalone-linux-x64.tar.gz  (内含 dsh-tui)
 *   - dsh-tui-standalone-linux-arm64.tar.gz (内含 dsh-tui)
 *   - dsh-tui-standalone-win-x64.zip       (内含 dsh-tui.exe)
 *   - dsh-tui-standalone-darwin-arm64.tar.gz (内含 dsh-tui)
 *   - dsh-tui-standalone-darwin-x64.tar.gz (内含 dsh-tui)
 */
import { execFileSync, execSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version

const argOut = process.argv.indexOf('--out')
const outDir = resolve(argOut >= 0 ? process.argv[argOut + 1] : join(root, 'dist-standalone'))

const argTargets = process.argv.indexOf('--targets')
const defaultTargets = 'node24-linux-x64,node24-linux-arm64,node24-win-x64,node24-macos-arm64,node24-macos-x64'
const targets = argTargets >= 0 ? process.argv[argTargets + 1] : defaultTargets

const standaloneDir = join(root, 'standalone')
const entryFile = join(standaloneDir, 'entry.mjs')
const pkgConfig = join(standaloneDir, 'pkg.config.json')
const runtimeTar = join(standaloneDir, 'runtime.tar.gz')

// ── 发布自助同步（一劳永逸）──────────────────────────────────────────
// 本脚本在构建时把 standalone/package.json 的 dsh-tui 依赖 spec 改写为当前
// 版本，而仓库提交的 pnpm-lock.yaml 仍解析上一个发行版——frozen install 会
// 因 spec 失配直接失败；且 pnpm ≥11 的 minimumReleaseAge（默认 24h）会拒绝
// 安装"刚发布"的自家包。以下三步让构建自愈，发版不再需要手工同步任何
// standalone 文件：
//   ① 临时关闭 minimumReleaseAge，用 --lockfile-only 只重解析被改写的
//      spec（其余依赖沿用 lock 的既有解析，供应链面不放大）；
//   ② 从重生成的 lockfile 解析自家包（dsh-tui / dsh-working-activity）的
//      实际版本，写入精确版本的 minimumReleaseAgeExclude 条目（替换旧条目）；
//   ③ 恢复配置后 --frozen-lockfile 严格按 lock 安装（#585 的供应链锁）。
const FIRST_PARTY_PACKAGES = ['@deepseek-harness-tui/dsh-tui', 'dsh-working-activity']
const workspaceYamlPath = join(standaloneDir, 'pnpm-workspace.yaml')
const lockfilePath = join(standaloneDir, 'pnpm-lock.yaml')

/**
 * Run `fn` with `minimumReleaseAge: <value>` temporarily forced in the
 * standalone workspace config; the original bytes are restored afterwards
 * (and on failure), including the key-absent case.
 */
function withMinimumReleaseAge(value, fn) {
  const original = readFileSync(workspaceYamlPath, 'utf8')
  const existing = /^minimumReleaseAge:.*$/m.exec(original)
  const modified = existing !== null
    ? original.replace(existing[0], `minimumReleaseAge: ${value}`)
    : `minimumReleaseAge: ${value}\n${original}`
  writeFileSync(workspaceYamlPath, modified, 'utf8')
  try {
    return fn()
  } finally {
    writeFileSync(workspaceYamlPath, original, 'utf8')
  }
}

/**
 * Distinct resolved versions of each first-party package in the lockfile —
 * packages/snapshot section keys read `'name@version'` / `'name@version(peers)'`.
 */
function firstPartyLockfileVersions() {
  const result = new Map(FIRST_PARTY_PACKAGES.map(name => [name, new Set()]))
  let text = ''
  try {
    text = readFileSync(lockfilePath, 'utf8')
  } catch {
    return result
  }
  for (const name of FIRST_PARTY_PACKAGES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Scoped names serialize as `'name@version'` (quoted), unscoped as
    // `name@version:` — the leading quote is optional and the capture stops
    // at a quote, a peer-suffix `(`, or the key's trailing `:`.
    const pattern = new RegExp(`^  '?${escaped}@([^'(:\\s]+)`, 'gm')
    for (const match of text.matchAll(pattern)) result.get(name).add(match[1])
  }
  return result
}

/**
 * Ensure the workspace config's minimumReleaseAgeExclude carries exact
 * entries for the given first-party versions (stale own entries replaced,
 * foreign entries preserved). Returns true when the file was written.
 */
function syncReleaseAgeExcludes(versionsByName) {
  let text = ''
  try {
    text = readFileSync(workspaceYamlPath, 'utf8')
  } catch {
    return false
  }
  const ours = []
  for (const [name, versions] of versionsByName) {
    if (versions.size > 0) ours.push(`  - '${name}@${[...versions].sort().join(' || ')}'`)
  }
  if (ours.length === 0) return false
  const lines = text.split(/\r?\n/)
  let blockStart = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line !== '' && line === line.trimStart() && /^minimumReleaseAgeExclude:/.test(line)) {
      blockStart = i
      break
    }
  }
  if (blockStart === -1) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
    lines.push('minimumReleaseAgeExclude:', ...ours)
  } else {
    let blockEnd = blockStart + 1
    const kept = []
    for (let i = blockStart + 1; i < lines.length; i++) {
      const line = lines[i]
      if (line === '' || line === line.trimStart()) break
      blockEnd = i + 1
      const item = line.trim().replace(/^-\s*/, '').replace(/^'(.*)'$/, '$1')
      if (!FIRST_PARTY_PACKAGES.some(name => item === name || item.startsWith(`${name}@`))) kept.push(line)
    }
    lines.splice(blockStart + 1, blockEnd - blockStart - 1, ...kept, ...ours)
  }
  const next = `${lines.join('\n')}\n`
  if (next === text) return false
  writeFileSync(workspaceYamlPath, next, 'utf8')
  return true
}

console.log(`\n============================================`)
console.log(`  dsh-TUI Standalone Bundle Builder`)
console.log(`  Version: ${version}`)
console.log(`  Targets: ${targets}`)
console.log(`  Output:  ${outDir}`)
console.log(`============================================\n`)

// 1. 同步版本号
console.log('==> 同步版本号到 standalone 配置…')
const standalonePkgPath = join(standaloneDir, 'package.json')
if (existsSync(standalonePkgPath)) {
  const sPkg = JSON.parse(readFileSync(standalonePkgPath, 'utf8'))
  if (sPkg.dependencies && sPkg.dependencies['@deepseek-harness-tui/dsh-tui']) {
    sPkg.dependencies['@deepseek-harness-tui/dsh-tui'] = version
  }
  writeFileSync(standalonePkgPath, `${JSON.stringify(sPkg, null, 2)}\n`, 'utf8')
}

if (existsSync(entryFile)) {
  let entryContent = readFileSync(entryFile, 'utf8')
  entryContent = entryContent.replace(
    /const TUI_VERSION = '.*?'/,
    `const TUI_VERSION = '${version}'`,
  )
  writeFileSync(entryFile, entryContent, 'utf8')
}

// 2. 构建 runtime.tar.gz 运行时资源包
console.log('==> 构建 runtime.tar.gz 运行时资源包…')
rmSync(runtimeTar, { force: true })
console.log('    正在同步 lockfile（仅重解析改写的 spec）…')
// 版本号同步改写了 dsh-tui 的依赖 spec，提交的 lockfile 仍解析上一发行版；
// --lockfile-only 只重解析该 spec（其余依赖沿用既有解析），且需临时关闭
// minimumReleaseAge——刚发布的版本必然落在 24h 窗口内。失败即中止构建。
withMinimumReleaseAge(0, () => {
  execSync('pnpm install --lockfile-only', { cwd: standaloneDir, stdio: 'inherit' })
})
const firstParty = firstPartyLockfileVersions()
if (syncReleaseAgeExcludes(firstParty)) {
  const described = [...firstParty.entries()]
    .filter(([, versions]) => versions.size > 0)
    .map(([name, versions]) => `${name}@${[...versions].sort().join(' || ')}`)
    .join(', ')
  console.log(`    已同步 minimumReleaseAgeExclude：${described}`)
}
console.log('    正在执行 pnpm install…')
// --frozen-lockfile：便携包供应链锁死——install 只按 pnpm-lock.yaml 的
// 已解析版本装包，绝不隐式改 lock 拉新（--no-frozen-lockfile 会让每次
// 构建重新解析依赖，被投毒的镜像/registry 能在构建机无感知换入恶意
// 版本并打进发布产物）。lock 失配会直接失败，提示提交新的 lock 而非
// 构建期静默重解析；上面的 lockfile-only 预同步保证 spec 与 lock 一致，
// 刚发布自家包的 24h 门禁由精确版本豁免承接。
execSync('pnpm install --frozen-lockfile', { cwd: standaloneDir, stdio: 'inherit' })
console.log('    正在打包 node_modules 到 runtime.tar.gz…')
execFileSync('tar', ['-czf', runtimeTar, 'node_modules'], { cwd: standaloneDir, stdio: 'inherit' })
const tarStat = statSync(runtimeTar)
console.log(`    [OK] runtime.tar.gz (${(tarStat.size / 1024 / 1024).toFixed(2)} MB)`)

if (process.argv.includes('--skip-pkg')) {
  console.log('\n[OK] --skip-pkg 指定，跳过 pkg 二进制编译。')
  process.exit(0)
}

// 3. 准备输出目录与临时构建目录
const stageDir = join(outDir, '.stage')
rmSync(stageDir, { recursive: true, force: true })
mkdirSync(stageDir, { recursive: true })
mkdirSync(outDir, { recursive: true })

// 4. 调用 pkg 编译
console.log(`\n==> 编译 Standalone 二进制 (${targets})…`)
const pkgArgs = [
  '--yes',
  '@yao-pkg/pkg@6.22.0',
  entryFile,
  '--config',
  pkgConfig,
  '--targets',
  targets,
  '--out-path',
  stageDir,
  '--compress',
  'GZip',
  '--no-bytecode',
  '--public',
]
execFileSync('npx', pkgArgs, { cwd: root, stdio: 'inherit' })

// 5. 整理产物并归档压缩
console.log(`\n==> 打包压缩各平台便携包…`)
const stagedFiles = readdirSync(stageDir)

const targetMap = [
  { match: /^entry-linux-arm64$/i, platform: 'linux-arm64', binary: 'dsh-tui', format: 'tar.gz' },
  { match: /^(?:entry-linux(?:-x64)?|entry)$/i, platform: 'linux-x64', binary: 'dsh-tui', format: 'tar.gz' },
  { match: /^entry-win(?:-x64)?(?:\.exe)?$/i, platform: 'win-x64', binary: 'dsh-tui.exe', format: 'zip' },
  { match: /^entry-(?:macos|darwin)-arm64$/i, platform: 'darwin-arm64', binary: 'dsh-tui', format: 'tar.gz' },
  { match: /^entry-(?:macos|darwin)(?:-x64)?$/i, platform: 'darwin-x64', binary: 'dsh-tui', format: 'tar.gz' },
]

for (const stagedFile of stagedFiles) {
  const stagedPath = join(stageDir, stagedFile)
  const stat = statSync(stagedPath)
  if (!stat.isFile()) continue

  let matched = null
  for (const item of targetMap) {
    if (item.match.test(stagedFile)) {
      matched = item
      break
    }
  }

  if (!matched) {
    console.warn(`    [WARN] 未知构建目标产物: ${stagedFile}，跳过打包`)
    continue
  }

  const { platform, binary: binaryName, format } = matched
  const archiveName = `dsh-tui-standalone-${platform}.${format}`
  const archivePath = join(outDir, archiveName)

  // 临时存放二进制并赋权
  const binDir = join(stageDir, `bin-${platform}`)
  rmSync(binDir, { recursive: true, force: true })
  mkdirSync(binDir, { recursive: true })
  const targetBinPath = join(binDir, binaryName)
  copyFileSync(stagedPath, targetBinPath)
  try {
    chmodSync(targetBinPath, 0o755)
  } catch {
    // Windows file permissions
  }

  // 压缩归档
  if (existsSync(archivePath)) rmSync(archivePath, { force: true })
  if (format === 'zip') {
    if (process.platform === 'win32') {
      // 优先 Windows 10+ 自带 bsdtar（-a 按后缀写 zip），数组参数不经
      // shell、无注入面；tar 缺失才回退 Compress-Archive——路径含 `'`
      // 会闭合单引号字面量注入命令，必须按 PowerShell 约定把 ' 双写为 ''
      // （与 src/update.ts 的 escapePsSingleQuoted 同款）。
      let tarOk = true
      try {
        execFileSync('tar', ['--version'], { stdio: 'ignore' })
      } catch {
        tarOk = false
      }
      if (tarOk) {
        execFileSync('tar', ['-a', '-cf', archivePath, '-C', binDir, binaryName], { stdio: 'inherit' })
      } else {
        const psQuote = (s) => `'${s.replace(/'/g, "''")}'`
        execFileSync('powershell', [
          '-NoProfile', '-Command',
          `Compress-Archive -Path ${psQuote(targetBinPath)} -DestinationPath ${psQuote(archivePath)} -Force`,
        ], { stdio: 'inherit' })
      }
    } else {
      execFileSync('zip', ['-j', archivePath, targetBinPath], { stdio: 'inherit' })
    }
  } else {
    execFileSync('tar', ['-czf', archivePath, '-C', binDir, binaryName], { stdio: 'inherit' })
  }

  const archStat = statSync(archivePath)
  console.log(`    [OK] ${archiveName} (${(archStat.size / 1024 / 1024).toFixed(2)} MB)`)
}

rmSync(stageDir, { recursive: true, force: true })
console.log(`\n便携包构建完成！产物位于：${outDir}`)
