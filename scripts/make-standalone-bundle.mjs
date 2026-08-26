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
console.log('    正在执行 pnpm install…')
// --frozen-lockfile：便携包供应链锁死——install 只按 pnpm-lock.yaml 的
// 已解析版本装包，绝不隐式改 lock 拉新（--no-frozen-lockfile 会让每次
// 构建重新解析依赖，被投毒的镜像/registry 能在构建机无感知换入恶意
// 版本并打进发布产物）。lock 失配会直接失败，提示提交新的 lock 而非
// 构建期静默重解析。
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
